# Extension icons

Generated from [`logo.png`](../../../logo.png) at the repo root — the project's
one piece of artwork, at 1200×1200 with a transparent ground. Everything else
in the project is a downscale of it, so there is one icon rather than several
that drift.

Chrome wants PNG here, so these are conversions rather than an `.ico`.

**Do not edit these by hand.** Rebuild every icon in the project — these four,
`vscode/icon.png`, and the multi-size `icon.ico` the tray app compiles in:

```bash
python tools/icons.py
```

Run it from the repo root. Pillow is a design-time dependency; nothing at
runtime needs it.

The sizes are the four `manifest.json` declares, for both `icons` (the
extensions page) and `action.default_icon` (the toolbar).

## What to expect at small sizes

The logo carries a "Bridge" wordmark under the mark. It stays readable down to
48px; at 32 it is a suggestion, and at 16 only the `Ai` shape survives. That is
ordinary for a logo with type in it — the 16px slot is a favicon, not a place
to read a word.

If that ever matters enough to fix, the answer is a separate mark-only artwork
for the small sizes rather than sharpening this one.
