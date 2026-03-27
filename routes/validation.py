"""
PortolanCAST — Validation Engine Route

Purpose:
    Scans the entity graph for a document and reports incomplete control loops,
    orphan sensors, missing connections, and unlinked equipment. Pattern
    constraints define the rules — this module enforces them.

    Part of Haystack Phase 4: the first automated quality check for equipment
    markup data. Designed to catch common omissions before field deployment.

Security assumptions:
    - doc_id is validated against the database (returns 404 if missing)
    - No user-controlled SQL — all queries are parameterized
    - Read-only: validation never modifies data

Threat model:
    - Invalid doc_id could probe for document existence
    - Mitigation: standard 404 (same as other document endpoints)

Author: PortolanCAST
Date: 2026-03-26
"""

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from config import db

router = APIRouter()


# =============================================================================
# VALIDATION RULES
# =============================================================================
# Each rule is a function that examines one entity and its connections,
# returning a list of findings (possibly empty). Rules are intentionally
# simple — one concern per function — so they're easy to test and extend.
#
# Severity levels:
#   error   — broken constraint, must be fixed before field use
#   warning — suspicious but not necessarily wrong
#   info    — suggestion for better data quality
# =============================================================================


def _build_entity_finding(severity, rule, message, entity, doc_id):
    """
    Construct a standardized finding dict.

    Every finding carries enough context to navigate the UI directly to
    the entity on the correct page — entity_id for selection, page_number
    for page navigation, building/tag for human readability.

    Args:
        severity: 'error', 'warning', or 'info'.
        rule: Machine-readable rule name (e.g., 'orphan_sensor').
        message: Human-readable description of the finding.
        entity: Entity dict (must include id, tag_number, building, page_number).
        doc_id: Document ID for navigation context.

    Returns:
        Finding dict.
    """
    return {
        "severity": severity,
        "rule": rule,
        "message": message,
        "entity_id": entity["id"],
        "entity_tag": entity.get("tag_number", "?"),
        "building": entity.get("building", ""),
        "page_number": entity.get("page_number", 1),
        "doc_id": doc_id,
    }


def _parse_constraints(pattern):
    """
    Extract the required_connections constraint from a pattern.

    Constraints are stored as JSON in the pattern's 'constraints' field.
    If already parsed (dict), use directly. If missing or malformed,
    return empty — the entity won't trigger connection-count rules.

    Args:
        pattern: Pattern dict with 'constraints' field.

    Returns:
        Dict with 'min_incoming' and 'min_outgoing' keys, or empty dict.
    """
    constraints = pattern.get("constraints", {})
    if isinstance(constraints, str):
        try:
            constraints = json.loads(constraints)
        except (json.JSONDecodeError, TypeError):
            return {}
    return constraints.get("required_connections", {})


def _check_entity(entity, pattern, outgoing_count, incoming_count, doc_id):
    """
    Apply all validation rules to a single entity.

    Rules are evaluated in priority order (errors first). Each rule
    checks one specific condition and appends a finding if violated.

    Args:
        entity: Entity dict with id, tag_number, building, pattern_id, etc.
        pattern: Parsed pattern dict (from db.get_pattern), or None.
        outgoing_count: Number of outgoing connections for this entity.
        incoming_count: Number of incoming connections for this entity.
        doc_id: Document ID for finding context.

    Returns:
        List of finding dicts (may be empty if entity passes all checks).
    """
    findings = []
    total = outgoing_count + incoming_count

    if not pattern:
        # No pattern assigned — can't check constraints, just note it
        findings.append(_build_entity_finding(
            "info", "no_pattern",
            f"{entity.get('tag_number', '?')} has no pattern assigned — "
            f"consider assigning one for validation",
            entity, doc_id,
        ))
        return findings

    category = pattern.get("category", "")
    req = _parse_constraints(pattern)
    min_out = req.get("min_outgoing", 0)
    min_in = req.get("min_incoming", 0)

    # Rule 1: Orphan sensor — sensor with no outgoing connections
    # Sensors measure and transmit; zero outgoing means nobody reads the signal.
    if category == "sensor" and min_out > 0 and outgoing_count < min_out:
        findings.append(_build_entity_finding(
            "error", "orphan_sensor",
            f"Sensor {entity.get('tag_number', '?')} has no outgoing connections "
            f"(expected ≥{min_out})",
            entity, doc_id,
        ))

    # Rule 2: Orphan actuator — actuator with no incoming connections
    # Actuators receive commands; zero incoming means nothing controls them.
    if category == "actuator" and min_in > 0 and incoming_count < min_in:
        findings.append(_build_entity_finding(
            "error", "orphan_actuator",
            f"Actuator {entity.get('tag_number', '?')} has no incoming connections "
            f"(expected ≥{min_in})",
            entity, doc_id,
        ))

    # Rule 3: Incomplete controller — controller missing input OR output
    # Controllers close the loop: they need both sensor input and actuator output.
    if category == "controller":
        if min_in > 0 and incoming_count < min_in:
            findings.append(_build_entity_finding(
                "error", "incomplete_controller",
                f"Controller {entity.get('tag_number', '?')} missing input connections "
                f"(has {incoming_count}, needs ≥{min_in})",
                entity, doc_id,
            ))
        if min_out > 0 and outgoing_count < min_out:
            findings.append(_build_entity_finding(
                "error", "incomplete_controller",
                f"Controller {entity.get('tag_number', '?')} missing output connections "
                f"(has {outgoing_count}, needs ≥{min_out})",
                entity, doc_id,
            ))

    # Rule 4: Unlinked entity — has a pattern but zero total connections
    # Not necessarily wrong (early markup stage), but worth flagging.
    if total == 0 and not findings:
        findings.append(_build_entity_finding(
            "warning", "unlinked_entity",
            f"{entity.get('tag_number', '?')} ({pattern.get('name', 'unknown')}) "
            f"has no connections",
            entity, doc_id,
        ))

    return findings


# =============================================================================
# VALIDATION ORCHESTRATOR
# =============================================================================


def _validate_document(doc_id: int) -> dict:
    """
    Run all validation rules against entities in a document.

    Orchestration flow:
    1. Fetch all entities for the document (via markup_entities join)
    2. Fetch all connections for the document (source OR target in doc)
    3. Build per-entity connection counts from the flat connection list
    4. For each entity: load pattern, run rules, collect findings
    5. Sort findings (errors → warnings → info) and build summary

    Args:
        doc_id: Document ID to validate.

    Returns:
        Dict with 'findings' list and 'summary' counts.
    """
    entities = db.get_entities_for_document(doc_id)
    connections = db.get_all_connections_for_document(doc_id)

    # Build per-entity connection counts in one pass over connections.
    # This avoids N+1 queries — we already have all connections in memory.
    outgoing_counts = {}
    incoming_counts = {}
    for conn in connections:
        src = conn["source_id"]
        tgt = conn["target_id"]
        outgoing_counts[src] = outgoing_counts.get(src, 0) + 1
        incoming_counts[tgt] = incoming_counts.get(tgt, 0) + 1

    # Cache patterns to avoid redundant DB lookups when multiple entities
    # share the same pattern (common: 10 temperature sensors → 1 pattern).
    pattern_cache = {}
    all_findings = []
    counts = {"errors": 0, "warnings": 0, "info": 0, "pass": 0}

    for entity in entities:
        pid = entity.get("pattern_id")

        # Load pattern (with cache)
        pattern = None
        if pid:
            if pid not in pattern_cache:
                pattern_cache[pid] = db.get_pattern(pid)
            pattern = pattern_cache[pid]

        out_count = outgoing_counts.get(entity["id"], 0)
        in_count = incoming_counts.get(entity["id"], 0)

        findings = _check_entity(entity, pattern, out_count, in_count, doc_id)

        if findings:
            all_findings.extend(findings)
            for f in findings:
                if f["severity"] == "error":
                    counts["errors"] += 1
                elif f["severity"] == "warning":
                    counts["warnings"] += 1
                else:
                    counts["info"] += 1
        else:
            counts["pass"] += 1

    # Sort: errors first, then warnings, then info
    severity_order = {"error": 0, "warning": 1, "info": 2}
    all_findings.sort(key=lambda f: (
        severity_order.get(f["severity"], 9),
        f.get("entity_tag", ""),
    ))

    return {
        "findings": all_findings,
        "summary": {
            "entities_checked": len(entities),
            **counts,
        },
    }


# =============================================================================
# ROUTE
# =============================================================================


@router.post("/api/documents/{doc_id}/validate")
async def validate_document(doc_id: int):
    """
    Run validation rules against all entities in a document.

    Examines each entity's pattern constraints and connection counts,
    reporting incomplete control loops, orphan sensors/actuators, and
    unlinked equipment.

    Args:
        doc_id: Document to validate.

    Returns:
        JSON with 'findings' list and 'summary' counts.

    Raises:
        404 if document not found.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    result = _validate_document(doc_id)
    return JSONResponse(result)
