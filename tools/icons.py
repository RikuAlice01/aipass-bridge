#!/usr/bin/env python3
"""Rebuild every icon in the project from logo.png.

    python tools/icons.py

logo.png is the source of truth: one high-resolution artwork with a transparent
ground, from which everything else is a downscale. Nothing here is hand-edited,
so a new logo means running this and nothing more.

Pillow is a design-time dependency, not a runtime one — the bridge, the CLIs
and both extensions still install nothing.
"""
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("this needs Pillow: pip install pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "logo.png")

# Windows picks the nearest size and scales the rest, so covering the common
# ones keeps Explorer, the taskbar and alt-tab from resampling a wrong-sized
# image themselves. 256 is what large-icon views and high-DPI taskbars use.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# Chrome wants these four; VS Code wants one 128.
PNG_TARGETS = [
    (os.path.join(ROOT, "aipass-bridge", "extension", "icons", "icon-16.png"), 16),
    (os.path.join(ROOT, "aipass-bridge", "extension", "icons", "icon-32.png"), 32),
    (os.path.join(ROOT, "aipass-bridge", "extension", "icons", "icon-48.png"), 48),
    (os.path.join(ROOT, "aipass-bridge", "extension", "icons", "icon-128.png"), 128),
    (os.path.join(ROOT, "aipass-bridge", "vscode", "icon.png"), 128),
]

ICO = os.path.join(ROOT, "icon.ico")


def main():
    if not os.path.exists(SOURCE):
        sys.exit(f"missing {SOURCE}")

    source = Image.open(SOURCE).convert("RGBA")
    if source.width != source.height:
        print(f"warning: {SOURCE} is {source.width}x{source.height}, not square")
    if source.width < max(ICO_SIZES):
        print(f"warning: {SOURCE} is smaller than {max(ICO_SIZES)}px; icons will be upscaled")

    def scaled(size):
        # LANCZOS throughout: every target is a downscale from 1200, where it
        # keeps the wordmark readable further down than a box filter does.
        return source.resize((size, size), Image.LANCZOS)

    source.save(ICO, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print(f"{os.path.relpath(ICO, ROOT)}  {', '.join(str(s) for s in ICO_SIZES)}  "
          f"{os.path.getsize(ICO)} bytes")

    for path, size in PNG_TARGETS:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        scaled(size).save(path, optimize=True)
        print(f"{os.path.relpath(path, ROOT).replace(os.sep, '/')}  {size}px  "
              f"{os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
