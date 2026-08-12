#!/usr/bin/env python3
"""Regenerates rich-menu.png — the LINE Rich Menu image (PLAN.md 15.9).

Requires Pillow: pip install pillow
Run from anywhere; paths below are relative to this file:
    python3 worker/assets/generate-rich-menu.py

After changing this file or its output, re-run
`.github/workflows/worker-setup-rich-menu.yml` (Actions tab → "One-time - Set
up LINE Rich Menu" → Run workflow) to publish the new image to LINE — editing
the PNG alone doesn't push anything anywhere by itself.

Uses Noto Sans Thai (bundled in this folder, SIL Open Font License — see
fonts/OFL.txt) since Thai script needs a font that actually covers it; the
default Pillow font doesn't. Icons are drawn with plain shapes (no icon
library available in this environment) to match a white-badge-on-color-tile
style.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
FONT_DIR = HERE / "fonts"

# LINE rich menu images must be one of a few fixed sizes; 2500x1686 is the
# standard "full" size. 4x2 divides evenly (625x843 per tile) and fits 7
# real command tiles plus one non-tappable brand tile (see BUTTONS below) —
# grew from the original 3x2 grid when the AI Q&A feature (PLAN.md 15.10)
# needed a spot; checked with Pillow's textbbox first that every existing
# title still fits comfortably at the narrower width before committing to
# this over shrinking fonts or an uneven per-row column count.
WIDTH, HEIGHT = 2500, 1686
COLS, ROWS = 4, 2

PAGE_BG = (240, 247, 242)  # soft off-white, faint green tint
FRAME_BORDER = (22, 163, 74)  # same green as the tiles
TILE_GREEN = (22, 163, 74)
TILE_GREEN_ALT = (16, 145, 65)  # subtle shade so adjacent tiles read distinctly
TEXT_WHITE = (255, 255, 255)
ICON_STROKE = 16

FRAME_MARGIN = 28
FRAME_RADIUS = 56
GUTTER = 16
TILE_RADIUS = 30


def icon_help(draw, cx, cy, r, color, font):
    text = "?"
    bbox = draw.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((cx - w / 2 - bbox[0], cy - h / 2 - bbox[1]), text, font=font, fill=color)


def icon_money(draw, cx, cy, r, color):
    bar_w = r * 0.32
    gap = r * 0.16
    heights = [r * 0.7, r * 1.15, r * 1.5]
    xs = [cx - 1.5 * bar_w - gap, cx - 0.5 * bar_w, cx + 0.5 * bar_w + gap]
    base_y = cy + r * 0.75
    for x, h in zip(xs, heights):
        draw.rounded_rectangle([x, base_y - h, x + bar_w, base_y], radius=bar_w * 0.3, fill=color)


def icon_clock(draw, cx, cy, r, stroke, color):
    rad = r * 0.85
    draw.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], outline=color, width=stroke)
    draw.line([cx, cy, cx, cy - rad * 0.55], fill=color, width=stroke)
    draw.line([cx, cy, cx + rad * 0.42, cy + rad * 0.12], fill=color, width=stroke)
    draw.ellipse([cx - stroke * 0.7, cy - stroke * 0.7, cx + stroke * 0.7, cy + stroke * 0.7], fill=color)


def icon_camera(draw, cx, cy, r, stroke, color):
    body_w, body_h = r * 1.7, r * 1.1
    x0, y0 = cx - body_w / 2, cy - body_h / 2 + r * 0.18
    draw.rounded_rectangle(
        [x0, y0, x0 + body_w, y0 + body_h], radius=body_h * 0.2, outline=color, width=stroke
    )
    bump_w, bump_h = body_w * 0.32, body_h * 0.32
    bx0 = cx - bump_w / 2
    by0 = y0 - bump_h * 0.7
    draw.rounded_rectangle(
        [bx0, by0, bx0 + bump_w, by0 + bump_h + stroke], radius=6, outline=color, width=stroke
    )
    lens_r = body_h * 0.3
    draw.ellipse(
        [cx - lens_r, y0 + body_h / 2 - lens_r, cx + lens_r, y0 + body_h / 2 + lens_r],
        outline=color,
        width=stroke,
    )


def icon_calendar(draw, cx, cy, r, stroke, color):
    w, h = r * 1.6, r * 1.5
    x0, y0 = cx - w / 2, cy - h / 2 + r * 0.1
    draw.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=h * 0.14, outline=color, width=stroke)
    header_h = h * 0.3
    draw.line([x0, y0 + header_h, x0 + w, y0 + header_h], fill=color, width=stroke)
    ring_y0, ring_y1 = y0 - h * 0.1, y0 + header_h * 0.55
    draw.line([x0 + w * 0.28, ring_y0, x0 + w * 0.28, ring_y1], fill=color, width=stroke)
    draw.line([x0 + w * 0.72, ring_y0, x0 + w * 0.72, ring_y1], fill=color, width=stroke)
    for gy in range(2):
        for gx in range(3):
            px = x0 + w * (0.22 + gx * 0.28)
            py = y0 + header_h + h * (0.22 + gy * 0.28)
            dr = stroke * 0.6
            draw.ellipse([px - dr, py - dr, px + dr, py + dr], fill=color)


def icon_diary(draw, cx, cy, r, stroke, color):
    w, h = r * 1.4, r * 1.7
    x0, y0 = cx - w / 2, cy - h / 2
    draw.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=w * 0.14, outline=color, width=stroke)
    draw.line([x0 + w * 0.26, y0, x0 + w * 0.26, y0 + h], fill=color, width=max(2, stroke - 4))
    for i in range(3):
        ly = y0 + h * (0.32 + i * 0.22)
        draw.line([x0 + w * 0.42, ly, x0 + w * 0.86, ly], fill=color, width=max(2, stroke - 6))


def icon_sparkle(draw, cx, cy, r, color):
    # A 4-pointed star/sparkle — the shorthand for "AI" most chat apps use
    # (echoes Gemini's own logo mark), alternating an outer and inner radius
    # across 8 points around the center.
    outer, inner = r * 1.15, r * 0.4
    pts = []
    for i in range(8):
        angle = math.pi / 4 * i - math.pi / 2
        radius = outer if i % 2 == 0 else inner
        pts.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    draw.polygon(pts, fill=color)


def icon_wallet(draw, cx, cy, r, stroke, color):
    w, h = r * 1.8, r * 1.3
    x0, y0 = cx - w / 2, cy - h / 2
    draw.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=h * 0.18, outline=color, width=stroke)
    clasp_r = h * 0.16
    draw.ellipse(
        [x0 + w - clasp_r * 1.6, cy - clasp_r, x0 + w - clasp_r * 1.6 + clasp_r * 2, cy + clasp_r],
        outline=color,
        width=max(2, stroke - 6),
    )


BUTTONS = [
    {"title": "วิธีใช้", "sub": "HELP", "icon": "help"},
    {"title": "สรุปเดือนนี้", "sub": "MONEY SUMMARY", "icon": "money"},
    {"title": "รายการล่าสุด", "sub": "RECENT", "icon": "clock"},
    {"title": "ทริปตอนนี้", "sub": "TRIP STATUS", "icon": "camera"},
    {"title": "นัดวันนี้", "sub": "TODAY'S EVENTS", "icon": "calendar"},
    {"title": "ไดอารี่เดือนนี้", "sub": "DIARY", "icon": "diary"},
    {"title": "วิเคราะห์", "sub": "AI ANALYSIS", "icon": "sparkle"},
    # Not a command — no tap area is defined for this cell in
    # setup-rich-menu.mjs, so it's purely a brand tile that fills the 8th
    # slot in the 4x2 grid instead of leaving a dead, unlabeled rectangle.
    {"title": "ผู้ช่วยการเงิน", "sub": "LINE BOT", "icon": "wallet"},
]


def center_text(draw, cx, cy, text, font, fill):
    bbox = draw.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((cx - w / 2 - bbox[0], cy - h / 2 - bbox[1]), text, font=font, fill=fill)


def draw_icon(draw, kind, cx, cy, r, help_font):
    # Icons sit on the white circular badge, so they're drawn in the tile's
    # green (not white-on-white).
    color = TILE_GREEN
    if kind == "help":
        icon_help(draw, cx, cy, r, color, help_font)
    elif kind == "money":
        icon_money(draw, cx, cy, r, color)
    elif kind == "clock":
        icon_clock(draw, cx, cy, r, ICON_STROKE, color)
    elif kind == "camera":
        icon_camera(draw, cx, cy, r, ICON_STROKE, color)
    elif kind == "calendar":
        icon_calendar(draw, cx, cy, r, ICON_STROKE, color)
    elif kind == "diary":
        icon_diary(draw, cx, cy, r, ICON_STROKE, color)
    elif kind == "sparkle":
        icon_sparkle(draw, cx, cy, r, color)
    elif kind == "wallet":
        icon_wallet(draw, cx, cy, r, ICON_STROKE, color)


def main():
    bold = ImageFont.truetype(str(FONT_DIR / "NotoSansThai-Bold.ttf"), 78)
    regular = ImageFont.truetype(str(FONT_DIR / "NotoSansThai-Regular.ttf"), 40)
    icon_font = ImageFont.truetype(str(FONT_DIR / "NotoSansThai-Bold.ttf"), 150)

    image = Image.new("RGB", (WIDTH, HEIGHT), PAGE_BG)
    draw = ImageDraw.Draw(image)

    # Outer card frame, like the reference screenshot's rounded border.
    draw.rounded_rectangle(
        [FRAME_MARGIN, FRAME_MARGIN, WIDTH - FRAME_MARGIN, HEIGHT - FRAME_MARGIN],
        radius=FRAME_RADIUS,
        outline=FRAME_BORDER,
        width=10,
    )

    inner_pad = FRAME_MARGIN + 26
    grid_w = WIDTH - inner_pad * 2
    grid_h = HEIGHT - inner_pad * 2
    col_x = [inner_pad + grid_w * c / COLS for c in range(COLS + 1)]
    row_y = [inner_pad + grid_h * r / ROWS for r in range(ROWS + 1)]

    for i, btn in enumerate(BUTTONS):
        row, col = divmod(i, COLS)
        x0, x1 = col_x[col], col_x[col + 1]
        y0, y1 = row_y[row], row_y[row + 1]
        tile_color = TILE_GREEN if (row + col) % 2 == 0 else TILE_GREEN_ALT
        draw.rounded_rectangle(
            [x0 + GUTTER / 2, y0 + GUTTER / 2, x1 - GUTTER / 2, y1 - GUTTER / 2],
            radius=TILE_RADIUS,
            fill=tile_color,
        )

        cx = (x0 + x1) / 2
        tile_h = y1 - y0
        badge_cy = y0 + tile_h * 0.36
        badge_r = tile_h * 0.22
        draw.ellipse(
            [cx - badge_r, badge_cy - badge_r, cx + badge_r, badge_cy + badge_r], fill=(255, 255, 255)
        )
        draw_icon(draw, btn["icon"], cx, badge_cy, badge_r * 0.62, icon_font)

        center_text(draw, cx, y0 + tile_h * 0.68, btn["title"], bold, TEXT_WHITE)
        center_text(draw, cx, y0 + tile_h * 0.84, btn["sub"], regular, TEXT_WHITE)

    out_path = HERE / "rich-menu.png"
    image.save(out_path, "PNG", optimize=True)
    print(f"saved {image.size} -> {out_path}")


if __name__ == "__main__":
    main()
