import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

const ROOT = join(__dirname, "..")

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * `themeColour()` may reach Leaflet. It may not reach an inline style.
 *
 * It resolves a CSS custom property through `getComputedStyle`, which needs a
 * document — so on the server it returns the hex FALLBACK and on the client it
 * returns the computed token. Both are correct. They are not the same string,
 * and React compares strings.
 *
 * The result was a hydration mismatch on every load of
 * `/dashboard/events/new`: `border-top-color: rgb(240, 84, 35)` server-side
 * against `borderTop: 2.5px solid lab(61.25% 57.01 57.75)` client-side, from
 * three legend swatches in `components/geofence-editor.tsx`.
 *
 * It was invisible to every layer. `tsc` is happy, 2,456 unit tests are happy,
 * `next build` is happy, and the page renders correctly — the only symptom is a
 * console warning on a screen nobody reads the console of. Found by pointing
 * Chrome DevTools at the page; `browse` could only report that a mismatch
 * existed, with no subtree.
 *
 * The rule: Leaflet takes colours as JS strings on its layer options, at
 * runtime, after mount, where `var(--chart-1)` means nothing — that is what
 * `themeColour` is for. Anything that is plain DOM can have the variable
 * directly, and must.
 */
describe("themeColour never reaches a server-rendered style", () => {
  const files = [...sourceFiles(join(ROOT, "components")), ...sourceFiles(join(ROOT, "app"))]

  it("is only used by code that hands colours to a map", () => {
    const users = files.filter((f) => /\bthemeColour\(/.test(readFileSync(f, "utf8")))

    // Guards the guard: if nothing imports it, this test proves nothing.
    expect(users.length).toBeGreaterThan(0)

    for (const file of users) {
      const src = readFileSync(file, "utf8")
      /*
       * A map component, by its own import. Not an allowlist of filenames — the
       * `"use server"` guard was a hardcoded list of three and missed the second
       * instance of the bug it existed for.
       */
      expect(src).toMatch(/from "(react-)?leaflet"|from "leaflet"/)
    }
  })

  it("puts no resolved colour into a style prop in the map components", () => {
    /*
     * The narrower half, and the one that actually failed. A map component may
     * hold resolved colours for its layers; it may not put one in `style={{}}`,
     * which React renders on the server.
     */
    for (const rel of ["components/geofence-editor.tsx", "components/location-picker.tsx"]) {
      const src = readFileSync(join(ROOT, rel), "utf8")
      const styles = [...src.matchAll(/style=\{\{([\s\S]{0,200}?)\}\}/g)].map((m) => m[1])
      for (const style of styles) {
        expect(style).not.toMatch(/COLOURS\.|themeColour\(/)
      }
    }
  })
})
