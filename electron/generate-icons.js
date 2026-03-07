/**
 * PortolanCAST — Icon Generator
 *
 * Purpose:
 *   Converts the Ship of Theseus SVG brand mark into platform-specific
 *   icon formats required by electron-builder:
 *   - icons/icon.png  (512×512, for Linux AppImage)
 *   - icons/icon.ico  (multi-res, for Windows NSIS installer)
 *
 * Prerequisites:
 *   npm install sharp png-to-ico
 *
 * Usage:
 *   node generate-icons.js
 *
 * Note:
 *   This script uses sharp (libvips) for SVG→PNG rendering and
 *   png-to-ico for PNG→ICO conversion. Both are dev-only dependencies.
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-03-07
 */

const sharp = require('sharp');
const pngToIco = require('png-to-ico');
const fs = require('fs');
const path = require('path');

const SVG_PATH = path.join(__dirname, '..', 'static', 'img', 'portolan-icon.svg');
const ICONS_DIR = path.join(__dirname, 'icons');
const PNG_PATH = path.join(ICONS_DIR, 'icon.png');
const ICO_PATH = path.join(ICONS_DIR, 'icon.ico');

async function generateIcons() {
    // Ensure output directory exists
    fs.mkdirSync(ICONS_DIR, { recursive: true });

    console.log('Reading SVG from:', SVG_PATH);

    // Read SVG content
    const svgBuffer = fs.readFileSync(SVG_PATH);

    // Generate 512×512 PNG (used by Linux AppImage)
    console.log('Generating 512x512 PNG...');
    await sharp(svgBuffer)
        .resize(512, 512)
        .png()
        .toFile(PNG_PATH);
    console.log('  → icons/icon.png');

    // Generate 256×256 PNG for ICO conversion
    console.log('Generating 256x256 PNG for ICO...');
    const png256 = await sharp(svgBuffer)
        .resize(256, 256)
        .png()
        .toBuffer();

    // Generate multi-resolution ICO (used by Windows NSIS installer)
    // ICO contains 256, 128, 64, 48, 32, 16 px versions
    console.log('Generating multi-resolution ICO...');
    const sizes = [256, 128, 64, 48, 32, 16];
    const pngBuffers = await Promise.all(
        sizes.map(size =>
            sharp(svgBuffer).resize(size, size).png().toBuffer()
        )
    );

    const icoBuffer = await pngToIco(pngBuffers);
    fs.writeFileSync(ICO_PATH, icoBuffer);
    console.log('  → icons/icon.ico');

    console.log('Done! Icons generated successfully.');
}

generateIcons().catch(err => {
    console.error('Icon generation failed:', err.message);
    process.exit(1);
});
