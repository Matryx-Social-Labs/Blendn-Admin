# Brand source artwork

The original logo exports from the brand guideline. **Not served** — they live
here rather than in `public/` because they are 1–2 MB each at 1000px and nothing
references them, so putting them under `public/` would ship ~8 MB of unused
artwork to every browser that asked for it.

The assets the app actually uses are in `public/brand/`, taken from the design
system project so the placement and the file agree:

| File | Used by |
|---|---|
| `monogram-gradient.png` | `BrandLogo` — sidebar, header, login |
| `lockup-white.png` | reserved for full-lockup contexts |

Both are transparent RGBA. The previous `blend-logo.png` was not, which is why
the old component wrapped it in a white rounded plate to hide the box — a plate
that then read as a button.
