import { readFileSync } from "fs"
import { join } from "path"
import PHOTOS from "../scripts/seed-blr-photos.json"
import { MEDIA } from "../lib/constants"
import { seedBucketUrl } from "../scripts/seed-media"

/**
 * A seeded clip's poster is never the event's cover (SCRUM-1066).
 *
 * The app's event hero is `contain`, so a 16:9 clip in the square letterboxes and its poster shows in the bars until
 * the first frame. The staging seeds set every clip's `thumbnail_url` to the cover: another picture at another ratio,
 * around Rooftop Sundowner's clip. A poster is the clip's own first frame (docs/MEDIA.md) or none.
 */
const SEEDS = ["scripts/seed-blr-scenarios.ts", "scripts/seed-qa.ts", "scripts/seed-audit-fixtures.ts"]
const code = (rel: string) =>
  readFileSync(join(__dirname, "..", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

describe.each(SEEDS)("%s", (rel) => {
  it("never writes a cover as a clip's thumbnail_url", () => {
    expect(code(rel)).not.toMatch(/thumbnail_url:\s*(media\.cover\.url|coverUrl|cover\()/)
  })

  it("writes clip rows with their own poster or none (the control: the pattern is looking at the right code)", () => {
    expect(code(rel)).toMatch(/thumbnail_url:\s*(null|[\w.]*clip[\w.]*\.poster)\b/)
  })

  it("writes a clip row's size and length (task 30)", () => {
    expect(code(rel)).toMatch(/duration_ms:\s*[\w.]*clip[\w.]*\.duration_ms/)
  })
})

/**
 * The Featured clip (task 30 item 5): the Rooftop Sundowner clip was a 20.2 s Pexels file, past the 15 s every
 * organizer upload is held to, and it had no poster. The seeded clip is a 12 s cut, faststart, in our bucket, with
 * its own first frame beside it.
 */
describe("the scenario seed's clip", () => {
  const clip = (PHOTOS as unknown as { _clip: Record<string, unknown> })._clip

  it("is within the clip limit an upload is held to", () => {
    expect(clip.duration_ms).toEqual(expect.any(Number))
    expect(clip.duration_ms as number).toBeLessThanOrEqual(MEDIA.MAX_CLIP_MS)
  })

  it("is ours, with its own first frame as the poster and its size", () => {
    expect(clip.url).toBe(seedBucketUrl("seed/_clips/dj-red-purple-12s.mp4"))
    expect(clip.poster).toBe(seedBucketUrl("seed/_clips/dj-red-purple-12s-poster.jpg"))
    expect(clip).toMatchObject({ width: 1280, height: 720 })
  })
})
