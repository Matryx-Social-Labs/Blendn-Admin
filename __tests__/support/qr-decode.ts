import jsQR from "jsqr"

/*
 * Reading back a QR code drawn by `components/dashboard/qr-code.tsx`, for the
 * tests that need to know what a code says rather than that it looks like one
 * (`dashboard-kit.test.tsx`, `event-share.test.tsx`).
 */

/** The SVG's grid: its side in modules, and the dark runs (`M x y h len v1 …`). */
export function grid(html: string) {
  const viewBox = html.match(/viewBox="0 0 (\d+) \d+"/)
  const dark = html.match(/<path fill="#0d0c0c" d="([^"]+)"/)
  if (!viewBox || !dark) return null
  const runs = [...dark[1].matchAll(/M(\d+)[ ,](\d+) ?h(\d+)v1H\d+z/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    len: Number(m[3]),
  }))
  return { side: Number(viewBox[1]), runs }
}

/**
 * Decode what was drawn, rather than compare it with what the library would
 * draw: the SVG rasterised as it is — its own margin, nothing added — and
 * handed to a real decoder. A wrong value, a dropped row, a transposed axis
 * or a quiet zone too thin to scan all fail.
 */
export function decode(html: string): string | null {
  const g = grid(html)
  if (!g) return null
  const scale = 4
  const px = g.side * scale
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255)
  for (const { x, y, len } of g.runs) {
    for (let cx = x; cx < x + len; cx++) {
      for (let py = 0; py < scale; py++) {
        for (let pxl = 0; pxl < scale; pxl++) {
          const i = ((y * scale + py) * px + cx * scale + pxl) * 4
          rgba[i] = rgba[i + 1] = rgba[i + 2] = 0
        }
      }
    }
  }
  return jsQR(rgba, px, px)?.data ?? null
}
