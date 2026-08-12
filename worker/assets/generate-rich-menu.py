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
default Pillow font doesn't.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
FONT_DIR = HERE / "fonts"

# LINE rich menu images must be one of a few fixed sizes; 2500x1686 is the
# standard "full" size and divides evenly into a 3x2 button grid.
WIDTH, HEIGHT = 2500, 1686
COLS, ROWS = 3, 2
GUTTER = 10

# Column/row boundaries chosen to split evenly and sum exactly to WIDTH/HEIGHT
# (2500 isn't divisible by 3, so the middle/right columns are 1px narrower).
COL_X = [0, 834, 1667, 2500]
ROW_Y = [0, 843, 1686]

# title: shown big and bold. sub: small caption underneath, for orientation.
# color: button background. These MUST correspond 1:1 (same order) with the
# tap-area actions in worker/scripts/setup-rich-menu.mjs — this file only
# draws the picture, that script wires taps to the actual bot commands.
BUTTONS = [
    {"title": "วิธีใช้", "sub": "HELP", "color": (79, 70, 229)},
    {"title": "สรุปเดือนนี้", "sub": "MONEY SUMMARY", "color": (5, 150, 105)},
    {"title": "รายการล่าสุด", "sub": "RECENT", "color": (217, 119, 6)},
    {"title": "ทริปตอนนี้", "sub": "TRIP STATUS", "color": (219, 39, 119)},
    {"title": "นัดวันนี้", "sub": "TODAY'S EVENTS", "color": (2, 132, 199)},
    {"title": "ไดอารี่เดือนนี้", "sub": "DIARY", "color": (124, 58, 237)},
]


def center_text(draw, cx, cy, text, font, fill):
    bbox = draw.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((cx - w / 2 - bbox[0], cy - h / 2 - bbox[1]), text, font=font, fill=fill)


def main():
    bold = ImageFont.truetype(str(FONT_DIR / "NotoSansThai-Bold.ttf"), 92)
    regular = ImageFont.truetype(str(FONT_DIR / "NotoSansThai-Regular.ttf"), 46)

    image = Image.new("RGB", (WIDTH, HEIGHT), (24, 24, 27))
    draw = ImageDraw.Draw(image)

    for i, btn in enumerate(BUTTONS):
        row, col = divmod(i, COLS)
        x0, x1 = COL_X[col], COL_X[col + 1]
        y0, y1 = ROW_Y[row], ROW_Y[row + 1]
        draw.rounded_rectangle(
            [x0 + GUTTER, y0 + GUTTER, x1 - GUTTER, y1 - GUTTER], radius=36, fill=btn["color"]
        )
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        center_text(draw, cx, cy - 30, btn["title"], bold, (255, 255, 255))
        center_text(draw, cx, cy + 70, btn["sub"], regular, (255, 255, 255))

    out_path = HERE / "rich-menu.png"
    image.save(out_path, "PNG", optimize=True)
    print(f"saved {image.size} -> {out_path}")


if __name__ == "__main__":
    main()
