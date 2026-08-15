import { readFileSync } from "fs"
import { join } from "path"

/**
 * The numbers the organiser form tells people against the numbers we committed
 * to in `docs/MEDIA.md`.
 *
 * The cover field advised "Recommended 1200×630 px" — a landscape OG-image
 * ratio — while the spec calls for a square master because every card slot
 * crops from one. Nobody was wrong on purpose; the copy was written before the
 * spec and nothing connected them, so it simply kept being served to
 * organisers.
 *
 * This is a text test, which is weak, and it is still worth having: the failure
 * it catches is not a crash but confidently wrong advice, which nothing else in
 * the suite can see. It asserts agreement, not exact wording, so the copy stays
 * free to be rewritten as long as it keeps saying the same thing.
 */

const ROOT = join(__dirname, "..")

/**
 * Source with comments removed, because the assertions are about what an
 * organiser is *shown*.
 *
 * Both files explain the old wrong advice in a comment so nobody reinstates it,
 * and without this the "does not still say 1200×630" check fails on the note
 * explaining that it no longer says 1200×630.
 */
const read = (p: string) =>
  readFileSync(join(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")

const spec = readFileSync(join(ROOT, "docs/MEDIA.md"), "utf8")
const cover = read("components/event-form/cover-image-section.tsx")
const gallery = read("components/event-form/media-section.tsx")

/** Pull a `| **Label** | 2048 × 2048 |` row out of the spec. */
function specRow(label: string): string {
  const m = spec.match(new RegExp(`\\|\\s*\\**${label}\\**\\s*\\|\\s*([^|]+?)\\s*\\|`, "i"))
  if (!m) throw new Error(`"${label}" not found in docs/MEDIA.md`)
  return m[1]
}

describe("the form's media advice matches docs/MEDIA.md", () => {
  const recommended = specRow("Recommended") // 2048 × 2048
  const minimum = specRow("Minimum") // 1600 × 1600

  it("the spec still states a square master", () => {
    // Everything below is meaningless if these stopped being squares, so this
    // guards the assumption the other assertions rest on.
    const [w, h] = recommended.split("×").map((s) => Number(s.trim()))
    expect(w).toBe(h)
    expect(w).toBeGreaterThanOrEqual(2048)
  })

  it.each([
    ["cover image", cover],
    ["gallery", gallery],
  ])("%s quotes the recommended and minimum sizes", (_name, source) => {
    // Compared digit-wise so the copy can use any spacing around the ×.
    const digits = (s: string) => s.replace(/\D+/g, " ").trim()
    expect(digits(source)).toContain(digits(recommended))
    expect(digits(source)).toContain(digits(minimum))
  })

  it("neither field still advises the landscape OG ratio", () => {
    // The specific wrong number, named. A regression here is someone
    // reinstating it rather than inventing a new mistake.
    expect(cover).not.toMatch(/1200\s*[×x]\s*630/)
    expect(gallery).not.toMatch(/1200\s*[×x]\s*630/)
  })

  it("the gallery states the video constraints the app depends on", () => {
    expect(gallery).toMatch(/faststart/i)
    expect(gallery).toMatch(/H\.264/)
    expect(gallery).toMatch(/1080/)
    expect(gallery).toMatch(/15 seconds|15 s\b/i)
  })

  it("offers a poster field for video, since the app drops posterless clips", () => {
    // `feedClip` in the app falls back thumbnail_url -> cover_image_url ->
    // drop. Without this input the first link of that chain is unreachable.
    expect(gallery).toContain("thumbnail_url")
    expect(gallery).toMatch(/Poster image/)
  })

  it("constrains the file picker per media type", () => {
    expect(gallery).toMatch(/video\/mp4/)
    expect(gallery).toMatch(/image\/jpeg/)
  })
})
