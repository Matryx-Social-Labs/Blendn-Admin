import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import jsQR from "jsqr"

import { KpiStrip, Locked } from "@/components/dashboard/kit"
import { QR } from "@/components/dashboard/qr-code"

/*
 * The three kit components whose failure is invisible on screen.
 *
 * A locked tile that renders its value under the lock, or a preview fed the
 * organisation's real numbers, looks exactly like a correct one — the blur and
 * the lock icon are still there. And a QR code that encodes the wrong string
 * still looks like a QR code. Each is asserted on the output, not the styling.
 */

describe("KpiStrip", () => {
  const strip = (items: Parameters<typeof KpiStrip>[0]["items"]) =>
    renderToStaticMarkup(createElement(KpiStrip, { items }))

  it("renders an open tile's value", () => {
    expect(strip([{ label: "Turn-up", value: "73%" }])).toContain("73%")
  })

  it("renders no value on a locked tile, even when one reaches it", () => {
    /*
     * `LockedKpi` has no `value` field, so this needs a cast — which is the
     * case worth testing: a spread of the open tile's props onto a locked one
     * typechecks the moment someone widens the type, and the number would then
     * sit in the HTML under a lock icon.
     */
    const html = strip([
      { label: "Often no-show", locked: true, value: 9137, hint: "real hint 4242" } as never,
    ])
    expect(html).toContain("Often no-show")
    expect(html).toContain("Unlock with Analytics")
    expect(html).not.toContain("9137")
    expect(html).not.toContain("4242")
  })

  it("names the plan on a locked tile", () => {
    expect(strip([{ label: "Came back", locked: true }])).toContain("Analytics")
  })
})

describe("Locked", () => {
  const render = (props: Parameters<typeof Locked>[0]) =>
    renderToStaticMarkup(createElement(Locked, props))

  it("draws the sample it is given, hidden from assistive tech, behind the pitch", () => {
    const html = render({
      title: "See whether people met",
      body: "Connections, repeat attendance and turn-up, per event.",
      sample: createElement("span", null, "SAMPLE-ROW"),
    })
    expect(html).toContain("SAMPLE-ROW")
    expect(html).toMatch(/<div aria-hidden="true" inert="" data-locked-sample=""[^>]*>[^]*SAMPLE-ROW/)
    expect(html).toContain("See whether people met")
  })

  it("has no prop that carries real data", () => {
    /*
     * The type is the guard: a preview fed the org's own rows would sidestep
     * the suppression floors and put paid numbers in the page source. If a
     * `data`, `value` or `rows` prop is ever added, these lines stop erroring
     * and `tsc --noEmit` fails on the unused directives (TS2578). Not jest:
     * ts-jest only transpiles here (`isolatedModules`), so the lint/tsc step
     * is what enforces this one.
     */
    const base = { title: "t", body: "b", sample: null }
    // @ts-expect-error -- no real-data path into Locked
    void createElement(Locked, { ...base, data: [1, 2, 3] })
    // @ts-expect-error -- no real-data path into Locked
    void createElement(Locked, { ...base, value: 42 })
    // @ts-expect-error -- no real-data path into Locked
    void createElement(Locked, { ...base, rows: [] })
    // @ts-expect-error -- the sample is required: there is no "fetch it yourself" mode
    void createElement(Locked, { title: "t", body: "b" })
  })
})

describe("QR", () => {
  /**
   * Decode what was drawn, rather than compare it with what the library would
   * draw. The SVG's dark modules are runs (`M x y h len v1 …`); they are put
   * back on a grid with a four-module quiet zone, scaled up, and handed to a
   * real decoder. A wrong value, a dropped row or a transposed axis all fail.
   */
  function decode(html: string): string | null {
    const viewBox = html.match(/viewBox="0 0 (\d+) \d+"/)
    if (!viewBox) return null
    const modules = Number(viewBox[1])
    const quiet = 4
    const scale = 4
    const side = (modules + quiet * 2) * scale
    const rgba = new Uint8ClampedArray(side * side * 4).fill(255)

    const dark = html.match(/<path fill="#0d0c0c" d="([^"]+)"/)
    if (!dark) return null
    for (const m of dark[1].matchAll(/M(\d+)[ ,](\d+) ?h(\d+)v1H\d+z/g)) {
      const [x, y, len] = [Number(m[1]), Number(m[2]), Number(m[3])]
      for (let cx = x; cx < x + len; cx++) {
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            const i = (((y + quiet) * scale + py) * side + (cx + quiet) * scale + px) * 4
            rgba[i] = rgba[i + 1] = rgba[i + 2] = 0
          }
        }
      }
    }
    return jsQR(rgba, side, side)?.data ?? null
  }

  const render = (value: string) => renderToStaticMarkup(createElement(QR, { value }))

  it("encodes the URL it is given", () => {
    const url = "https://blendn.app/e/sunset-sessions?src=qr"
    expect(decode(render(url))).toBe(url)
  })

  it("encodes a different URL differently", () => {
    // The control: a decoder that returned a constant would pass the one above.
    const other = "https://blendn.app/e/another-night"
    expect(decode(render(other))).toBe(other)
  })

  it("is SVG elements with a name, never injected markup", () => {
    const html = render("https://blendn.app/e/x\"><script>alert(1)</script>")
    expect(html).not.toContain("<script>")
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="QR code for /)
  })
})
