# Extension icons

Generated from [`icon.ico`](../../../icon.ico) at the repo root — the same file
`build.rs` compiles into the tray app's `.exe`, so the project has one icon
rather than several that drift.

Chrome wants PNG here, so these are conversions rather than the `.ico` itself.

**If `icon.ico` changes, regenerate these.** The Rust build picks a new icon up
on its own (`cargo:rerun-if-changed`); this folder does not.

```bash
python - <<'EOF'
from PIL import Image
src = Image.open('icon.ico').convert('RGBA')
# NEAREST for whole-number upscales keeps pixel art crisp; LANCZOS elsewhere,
# because 1.5x nearest gives uneven pixel widths.
for size, how in {16: 'LANCZOS', 32: None, 48: 'LANCZOS', 128: 'NEAREST'}.items():
    out = src.copy() if how is None else src.resize((size, size), getattr(Image, how))
    out.save('aipass-bridge/extension/icons/icon-%d.png' % size, optimize=True)
EOF
```

Run it from the repo root. Sizes are the four `manifest.json` declares, for both
`icons` (the extensions page) and `action.default_icon` (the toolbar).

## Known limitation

`icon.ico` holds a single 32×32 image with **no transparency** — 47% of it is
opaque white, including all four corners. It therefore shows as a white square
on a dark toolbar or taskbar, and 128 is upscaled from 32 rather than drawn at
that size.

Both are fixed by replacing `icon.ico` with a larger source that has a
transparent background, and re-running the snippet above.
