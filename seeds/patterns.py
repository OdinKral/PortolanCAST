"""
PortolanCAST — HVAC Pattern & Tag Vocabulary Seed Data

Purpose:
    Provides the initial set of Haystack-inspired HVAC patterns and controlled
    tag vocabulary for the pattern system.  Inserted into the database on first
    init when the patterns table is empty.

Architecture:
    Patterns define *blueprints* for equipment types.  Each pattern carries:
      - Haystack-derived tags (structured, not free-form)
      - ISA-5.1 symbol + prefix for auto-numbering
      - Port definitions (input/output signal types)
      - Dual view labels (System View for humans, ISA View for engineers)

    System patterns compose component patterns into control loops
    (e.g., sensor → controller → actuator).

    Tag vocabulary is the controlled dictionary — only tags listed here can be
    assigned to entities.  This prevents the tag-soup problem that plagues
    free-form tagging systems.

Security:
    No external input.  All data is hardcoded and validated at insertion time.

References:
    - Project Haystack (https://project-haystack.org/) — tag ontology inspiration
    - ISA-5.1 — Instrumentation Symbols and Identification standard
    - PortolanCAST vision doc: PKM/Fleeting/Conversation_3_25_2026

Author: PortolanCAST
Version: 1.0.0
Date: 2026-03-26
"""

import json
import uuid

# =============================================================================
# HELPER — deterministic UUIDs from pattern names for stable seed IDs
# =============================================================================

# SECURITY: UUID5 with a fixed namespace ensures the same pattern name always
# produces the same ID across installations.  No randomness, no collisions.
_NAMESPACE = uuid.UUID("b8c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e")


def _pid(name: str) -> str:
    """Generate a deterministic UUID hex string from a pattern name."""
    return uuid.uuid5(_NAMESPACE, name).hex


# =============================================================================
# TAG VOCABULARY — Haystack-inspired controlled dictionary
# =============================================================================
# Categories group tags for UI presentation and query filtering.
# Each tag is a single Haystack-style marker (lowercase, no spaces).

TAG_VOCABULARY = [
    # --- Medium tags: what substance is being measured/controlled ---
    {"tag": "zone",     "category": "medium",      "description": "Conditioned space / thermal zone"},
    {"tag": "air",      "category": "medium",      "description": "Air medium"},
    {"tag": "water",    "category": "medium",      "description": "Water medium (hydronic)"},
    {"tag": "steam",    "category": "medium",      "description": "Steam medium"},
    {"tag": "chilled",  "category": "medium",      "description": "Chilled medium (chilled water, chilled air)"},
    {"tag": "hot",      "category": "medium",      "description": "Hot/heated medium"},
    {"tag": "mixed",    "category": "medium",      "description": "Mixed air (OA + RA blend)"},
    {"tag": "return",   "category": "medium",      "description": "Return path (return air, return water)"},
    {"tag": "supply",   "category": "medium",      "description": "Supply path (supply air, supply water)"},
    {"tag": "exhaust",  "category": "medium",      "description": "Exhaust path"},
    {"tag": "outside",  "category": "medium",      "description": "Outside / outdoor air"},
    {"tag": "discharge","category": "medium",      "description": "Discharge air (leaving coil or unit)"},
    {"tag": "condenser","category": "medium",      "description": "Condenser loop medium"},

    # --- Measurement tags: what physical quantity ---
    {"tag": "temp",     "category": "measurement", "description": "Temperature"},
    {"tag": "pressure", "category": "measurement", "description": "Pressure (static, differential, total)"},
    {"tag": "humidity", "category": "measurement", "description": "Relative humidity"},
    {"tag": "flow",     "category": "measurement", "description": "Flow rate (CFM, GPM)"},
    {"tag": "level",    "category": "measurement", "description": "Level (tank, reservoir)"},
    {"tag": "speed",    "category": "measurement", "description": "Rotational speed (RPM, %)"},
    {"tag": "power",    "category": "measurement", "description": "Electrical power (kW)"},
    {"tag": "energy",   "category": "measurement", "description": "Energy consumption (kWh, BTU)"},
    {"tag": "co2",      "category": "measurement", "description": "CO₂ concentration (ppm)"},
    {"tag": "current",  "category": "measurement", "description": "Electrical current (amps)"},

    # --- Function tags: what role the point plays ---
    {"tag": "sensor",     "category": "function",  "description": "Measures a physical quantity"},
    {"tag": "controller", "category": "function",  "description": "Runs control logic (PID, sequencing)"},
    {"tag": "actuator",   "category": "function",  "description": "Drives a physical device (valve, damper, VFD)"},
    {"tag": "setpoint",   "category": "function",  "description": "Target value for a control loop"},
    {"tag": "command",    "category": "function",  "description": "Output command signal (0-100%, on/off)"},
    {"tag": "status",     "category": "function",  "description": "Feedback status (running, alarm, fault)"},
    {"tag": "alarm",      "category": "function",  "description": "Alarm condition"},
    {"tag": "enable",     "category": "function",  "description": "Enable/disable signal"},

    # --- Equipment tags: what physical device ---
    {"tag": "valve",       "category": "equipment", "description": "Control valve (2-way, 3-way)"},
    {"tag": "damper",      "category": "equipment", "description": "Air damper (OA, RA, EA, zone)"},
    {"tag": "fan",         "category": "equipment", "description": "Fan / blower"},
    {"tag": "pump",        "category": "equipment", "description": "Circulation pump"},
    {"tag": "coil",        "category": "equipment", "description": "Heating or cooling coil"},
    {"tag": "compressor",  "category": "equipment", "description": "Refrigerant compressor"},
    {"tag": "filter",      "category": "equipment", "description": "Air or water filter"},
    {"tag": "economizer",  "category": "equipment", "description": "Economizer (free cooling)"},
    {"tag": "vfd",         "category": "equipment", "description": "Variable frequency drive"},
    {"tag": "ahu",         "category": "equipment", "description": "Air handling unit"},
    {"tag": "vav",         "category": "equipment", "description": "Variable air volume box"},
    {"tag": "fcu",         "category": "equipment", "description": "Fan coil unit"},
    {"tag": "chiller",     "category": "equipment", "description": "Chiller plant"},
    {"tag": "boiler",      "category": "equipment", "description": "Boiler / heating plant"},
]

# =============================================================================
# COMPONENT PATTERNS — blueprints for individual equipment points
# =============================================================================
# Each pattern maps to one "kind of thing" you'd find on a mechanical drawing.
# tags[] are auto-assigned to entities created from this pattern.
# isa_symbol is the ISA-5.1 instrument code.
# isa_prefix is used for auto-numbering (e.g., TT-1, TT-2, ...).
# ports define signal flow direction for connection validation.
# views define how the entity appears in System View vs ISA View.

COMPONENT_PATTERNS = [
    {
        "id": _pid("Zone Air Temperature Sensor"),
        "name": "Zone Air Temperature Sensor",
        "type": "component",
        "category": "sensor",
        "tags": json.dumps(["zone", "air", "temp", "sensor"]),
        "isa_symbol": "TT",
        "isa_prefix": "TT-",
        "ports": json.dumps({
            "output": {"type": "analog", "signal": "temperature", "unit": "°F"}
        }),
        "views": json.dumps({
            "system": {"label": "Zone Temp Sensor", "shape": "circle", "color": "#4fc3f7"},
            "isa":    {"label": "TT", "shape": "circle"}
        }),
        "constraints": json.dumps({
            "required_connections": {"output": 1}
        }),
        "is_builtin": 1,
    },
    {
        "id": _pid("Zone Air Temperature Setpoint"),
        "name": "Zone Air Temperature Setpoint",
        "type": "component",
        "category": "setpoint",
        "tags": json.dumps(["zone", "air", "temp", "setpoint"]),
        "isa_symbol": "TSP",
        "isa_prefix": "TSP-",
        "ports": json.dumps({
            "output": {"type": "analog", "signal": "temperature", "unit": "°F"}
        }),
        "views": json.dumps({
            "system": {"label": "Zone Temp Setpoint", "shape": "diamond", "color": "#81c784"},
            "isa":    {"label": "TSP", "shape": "diamond"}
        }),
        "constraints": json.dumps({}),
        "is_builtin": 1,
    },
    {
        "id": _pid("Temperature Controller"),
        "name": "Temperature Controller",
        "type": "component",
        "category": "controller",
        "tags": json.dumps(["temp", "controller"]),
        "isa_symbol": "TIC",
        "isa_prefix": "TIC-",
        "ports": json.dumps({
            "input":  {"type": "analog", "signal": "temperature"},
            "output": {"type": "analog", "signal": "command", "unit": "%"}
        }),
        "views": json.dumps({
            "system": {"label": "Temp Controller", "shape": "circle", "color": "#aed581"},
            "isa":    {"label": "TIC", "shape": "circle"}
        }),
        "constraints": json.dumps({
            "required_connections": {"input": 1, "output": 1}
        }),
        "is_builtin": 1,
    },
    {
        "id": _pid("Damper Command"),
        "name": "Damper Command",
        "type": "component",
        "category": "actuator",
        "tags": json.dumps(["damper", "command", "actuator"]),
        "isa_symbol": "TV",
        "isa_prefix": "TV-",
        "ports": json.dumps({
            "input": {"type": "analog", "signal": "command", "unit": "%"}
        }),
        "views": json.dumps({
            "system": {"label": "Damper Cmd", "shape": "bowtie", "color": "#ffb74d"},
            "isa":    {"label": "TV", "shape": "valve"}
        }),
        "constraints": json.dumps({
            "required_connections": {"input": 1}
        }),
        "is_builtin": 1,
    },
    {
        "id": _pid("Valve Command"),
        "name": "Valve Command",
        "type": "component",
        "category": "actuator",
        "tags": json.dumps(["valve", "command", "actuator"]),
        "isa_symbol": "TV",
        "isa_prefix": "TV-",
        "ports": json.dumps({
            "input": {"type": "analog", "signal": "command", "unit": "%"}
        }),
        "views": json.dumps({
            "system": {"label": "Valve Cmd", "shape": "bowtie", "color": "#ffb74d"},
            "isa":    {"label": "TV", "shape": "valve"}
        }),
        "constraints": json.dumps({
            "required_connections": {"input": 1}
        }),
        "is_builtin": 1,
    },
    {
        "id": _pid("Fan Command"),
        "name": "Fan Command",
        "type": "component",
        "category": "actuator",
        "tags": json.dumps(["fan", "command", "actuator"]),
        "isa_symbol": "SC",
        "isa_prefix": "SC-",
        "ports": json.dumps({
            "input": {"type": "analog", "signal": "command", "unit": "%"}
        }),
        "views": json.dumps({
            "system": {"label": "Fan Cmd", "shape": "circle", "color": "#ffb74d"},
            "isa":    {"label": "SC", "shape": "circle"}
        }),
        "constraints": json.dumps({
            "required_connections": {"input": 1}
        }),
        "is_builtin": 1,
    },
    {
        "id": _pid("Flow Transmitter"),
        "name": "Flow Transmitter",
        "type": "component",
        "category": "sensor",
        "tags": json.dumps(["flow", "sensor"]),
        "isa_symbol": "FT",
        "isa_prefix": "FT-",
        "ports": json.dumps({
            "output": {"type": "analog", "signal": "flow", "unit": "GPM"}
        }),
        "views": json.dumps({
            "system": {"label": "Flow Sensor", "shape": "circle", "color": "#4fc3f7"},
            "isa":    {"label": "FT", "shape": "circle"}
        }),
        "constraints": json.dumps({
            "required_connections": {"output": 1}
        }),
        "is_builtin": 1,
    },
    {
        "id": _pid("Pressure Transmitter"),
        "name": "Pressure Transmitter",
        "type": "component",
        "category": "sensor",
        "tags": json.dumps(["pressure", "sensor"]),
        "isa_symbol": "PT",
        "isa_prefix": "PT-",
        "ports": json.dumps({
            "output": {"type": "analog", "signal": "pressure", "unit": "inWC"}
        }),
        "views": json.dumps({
            "system": {"label": "Pressure Sensor", "shape": "circle", "color": "#4fc3f7"},
            "isa":    {"label": "PT", "shape": "circle"}
        }),
        "constraints": json.dumps({
            "required_connections": {"output": 1}
        }),
        "is_builtin": 1,
    },
    {
        "id": _pid("Humidity Sensor"),
        "name": "Humidity Sensor",
        "type": "component",
        "category": "sensor",
        "tags": json.dumps(["humidity", "sensor"]),
        "isa_symbol": "MT",
        "isa_prefix": "MT-",
        "ports": json.dumps({
            "output": {"type": "analog", "signal": "humidity", "unit": "%RH"}
        }),
        "views": json.dumps({
            "system": {"label": "Humidity Sensor", "shape": "circle", "color": "#4fc3f7"},
            "isa":    {"label": "MT", "shape": "circle"}
        }),
        "constraints": json.dumps({
            "required_connections": {"output": 1}
        }),
        "is_builtin": 1,
    },
    {
        "id": _pid("VFD Speed Controller"),
        "name": "VFD Speed Controller",
        "type": "component",
        "category": "controller",
        "tags": json.dumps(["vfd", "speed", "controller"]),
        "isa_symbol": "SIC",
        "isa_prefix": "SIC-",
        "ports": json.dumps({
            "input":  {"type": "analog", "signal": "command", "unit": "%"},
            "output": {"type": "analog", "signal": "speed", "unit": "Hz"}
        }),
        "views": json.dumps({
            "system": {"label": "VFD Controller", "shape": "circle", "color": "#aed581"},
            "isa":    {"label": "SIC", "shape": "circle"}
        }),
        "constraints": json.dumps({
            "required_connections": {"input": 1, "output": 1}
        }),
        "is_builtin": 1,
    },
    {
        "id": _pid("CO2 Sensor"),
        "name": "CO2 Sensor",
        "type": "component",
        "category": "sensor",
        "tags": json.dumps(["co2", "sensor"]),
        "isa_symbol": "AT",
        "isa_prefix": "AT-",
        "ports": json.dumps({
            "output": {"type": "analog", "signal": "co2", "unit": "ppm"}
        }),
        "views": json.dumps({
            "system": {"label": "CO₂ Sensor", "shape": "circle", "color": "#4fc3f7"},
            "isa":    {"label": "AT", "shape": "circle"}
        }),
        "constraints": json.dumps({
            "required_connections": {"output": 1}
        }),
        "is_builtin": 1,
    },
]

# =============================================================================
# SYSTEM PATTERNS — compositions of component patterns into control loops
# =============================================================================
# A system pattern is a named group of component patterns with roles.
# The "Zone Temperature Control Loop" is the canonical example:
#   sensor (TT) → controller (TIC) → actuator (TV)

SYSTEM_PATTERNS = [
    {
        "id": _pid("Zone Temperature Control Loop"),
        "name": "Zone Temperature Control Loop",
        "type": "system",
        "category": "system",
        "tags": json.dumps(["zone", "temp", "controller"]),
        "isa_symbol": "",
        "isa_prefix": "",
        "ports": json.dumps({}),
        "views": json.dumps({
            "system": {"label": "Zone Temp Loop", "shape": "group"},
            "isa":    {"label": "TC Loop", "shape": "group"}
        }),
        "constraints": json.dumps({
            "min_components": 3,
            "required_roles": ["sensor", "controller", "actuator"]
        }),
        "is_builtin": 1,
    },
]

# Members of the Zone Temperature Control Loop
SYSTEM_PATTERN_MEMBERS = [
    {
        "id": _pid("ZTCL-sensor"),
        "system_pattern_id": _pid("Zone Temperature Control Loop"),
        "member_pattern_id": _pid("Zone Air Temperature Sensor"),
        "role": "sensor",
        "required": 1,
        "sort_order": 0,
    },
    {
        "id": _pid("ZTCL-controller"),
        "system_pattern_id": _pid("Zone Temperature Control Loop"),
        "member_pattern_id": _pid("Temperature Controller"),
        "role": "controller",
        "required": 1,
        "sort_order": 1,
    },
    {
        "id": _pid("ZTCL-actuator"),
        "system_pattern_id": _pid("Zone Temperature Control Loop"),
        "member_pattern_id": _pid("Damper Command"),
        "role": "actuator",
        "required": 1,
        "sort_order": 2,
    },
]

# =============================================================================
# ALL PATTERNS — combined list for bulk insertion
# =============================================================================

ALL_PATTERNS = COMPONENT_PATTERNS + SYSTEM_PATTERNS
