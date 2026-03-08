"""
PortolanCAST — Icon Generator (Python/Pillow version)

Purpose:
    Generates a 256x256 PNG icon from the Ship of Theseus brand mark
    for electron-builder. Uses Pillow to draw the ship programmatically
    since SVG-to-PNG conversion requires additional system libraries.

Usage:
    python generate-icons.py

Output:
    icons/icon.png (256x256)

Author: PortolanCAST
Version: 1.0.0
Date: 2026-03-07
"""

import os
from PIL import Image, ImageDraw

# Output path
ICONS_DIR = os.path.join(os.path.dirname(__file__), 'icons')
os.makedirs(ICONS_DIR, exist_ok=True)

# Create 256x256 image with dark background (matches splash screen)
SIZE = 256
img = Image.new('RGBA', (SIZE, SIZE), (26, 26, 46, 255))  # #1a1a2e
draw = ImageDraw.Draw(img)

# Scale factor: SVG viewBox is 32x32, we're drawing at 256x256
S = SIZE / 32

# Colors from portolan-icon.svg
BLUE = (74, 158, 255, 255)       # #4a9eff
KEEL = (45, 120, 204, 255)       # #2d78cc
GOLD = (255, 215, 0, 255)        # #ffd700
SAIL = (74, 158, 255, 166)       # #4a9eff @ 0.65 opacity

# Pennant (gold triangle at masthead)
draw.polygon([
    (16*S, 4*S), (21*S, 6*S), (16*S, 7.5*S)
], fill=GOLD)

# Mast (vertical line)
draw.line([(16*S, 4*S), (16*S, 18*S)], fill=BLUE, width=max(2, int(2*S)))

# Yardarm (horizontal line)
draw.line([(10*S, 9*S), (22*S, 9*S)], fill=BLUE, width=max(1, int(1.5*S)))

# Main sail (filled rectangle, slight taper)
draw.polygon([
    (10.5*S, 9.5*S), (21.5*S, 9.5*S),
    (21*S, 16*S), (11*S, 16*S)
], fill=SAIL)

# Aft castle (stern, left side)
draw.rounded_rectangle(
    [(3*S, 15*S), (10*S, 21*S)],
    radius=int(1*S), fill=BLUE
)

# Main deck (center hull)
draw.rectangle([(8*S, 17*S), (25*S, 21*S)], fill=BLUE)

# Fore castle (bow, right side — pointed)
draw.polygon([
    (23*S, 16*S), (29*S, 19*S),
    (29*S, 21*S), (23*S, 21*S)
], fill=BLUE)

# Keel curve (darker blue underside)
# Approximate the quadratic bezier with a polygon
keel_points = []
for i in range(30):
    t = i / 29
    x = 3 + 26 * t
    # Quadratic bezier from (3,21) through (16,30) to (29,21)
    y = (1-t)**2 * 21 + 2*(1-t)*t * 30 + t**2 * 21
    keel_points.append((x*S, y*S))
# Bottom curve (offset down by 1.5)
for i in range(29, -1, -1):
    t = i / 29
    x = 3 + 26 * t
    y = (1-t)**2 * 22.5 + 2*(1-t)*t * 31.5 + t**2 * 22.5
    keel_points.append((x*S, y*S))
draw.polygon(keel_points, fill=KEEL)

# Save PNG
png_path = os.path.join(ICONS_DIR, 'icon.png')
img.save(png_path, 'PNG')
print(f'Generated: {png_path} ({SIZE}x{SIZE})')

print('Done!')
