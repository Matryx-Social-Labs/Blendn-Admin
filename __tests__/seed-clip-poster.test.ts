import { readFileSync } from "fs"
import { join } from "path"

/**
 * A seeded clip's poster is never the event's cover (SCRUM-1066).
 *
 * The app's event hero is `contain`, so a 16:9 clip in the square letterboxes and its poster shows in the bars until
 * the first frame. The staging seeds set every clip's `thumbnail_url` to the cover: another picture at another ratio,
 * around Rooftop Sundowner's clip. A poster is the clip's own first frame (docs/MEDIA.md) or none.
 */
const SEEDS = ["scripts/seed-blr-scenarios.ts", "scripts/seed-qa.ts"]
const code = (rel: string) =>
  readFileSync(join(__dirname, "..", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

describe.each(SEEDS)("%s", (rel) => {
  it("never writes the cover as a clip's thumbnail_url", () => {
    expect(code(rel)).not.toMatch(/thumbnail_url:\s*(media\.cover\.url|coverUrl)\b/)
  })

  it("still writes video rows (the control: the pattern is looking at the right code)", () => {
    expect(code(rel)).toMatch(/thumbnail_url:\s*null/)
  })
})
