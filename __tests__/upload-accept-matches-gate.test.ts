import { readFileSync } from "fs"
import { join } from "path"

import { validateContentType } from "@/lib/tigris"

/**
 * Every format the event form offers must be one the upload gate accepts.
 *
 * These are two lists in two files that have to agree, and they silently did
 * not. `media-section.tsx` offered Type = Video, its file input accepted
 * `video/mp4`, the help text specified the encode down to faststart, and the
 * component's own comment said "video has always been supported here" — while
 * `validateContentType` allowed only images for the `events` folder. Every
 * organiser who picked a clip got a 400 from `/api/uploads/presigned-url`, with
 * nothing on screen to say the format was the reason.
 *
 * The `ACCEPT` map's comment claimed it was "narrower than what the storage
 * bucket accepts". It was the other way round, which is the sort of thing only
 * a test comparing the two can keep honest.
 *
 * Read as source text rather than imported: `media-section.tsx` is a client
 * component, and pulling React into a unit test to read one constant is a worse
 * trade than a regex over the file the constant lives in.
 */
const ROOT = join(__dirname, "..")
const SOURCE = join("components", "event-form", "media-section.tsx")

/**
 * Offered but not accepted, on purpose, with the reason.
 *
 * `document` is in the `media_type` enum and in the form's Type select, and
 * nothing renders one — not the mobile media response, not the event page. So
 * allowing PDFs into the bucket would store a file no surface can show. The
 * open question is whether to build the reader or drop the option; until that
 * is decided the gap is recorded here rather than hidden by widening the gate.
 */
const KNOWN_UNRENDERED: Record<string, string> = {
  "application/pdf": "media_type.document has no renderer — build one or drop the option",
}

function acceptMap(): Record<string, string> {
  const src = readFileSync(join(ROOT, SOURCE), "utf8")
  const block = src.match(/const ACCEPT: Record<string, string> = \{([\s\S]*?)\}/)
  if (!block) throw new Error(`ACCEPT map not found in ${SOURCE} — the guard is reading the wrong shape`)
  const out: Record<string, string> = {}
  for (const [, key, value] of block[1].matchAll(/(\w+):\s*"([^"]+)"/g)) out[key] = value
  return out
}

describe("the event form only offers formats the upload gate accepts", () => {
  const ACCEPT = acceptMap()

  it("found the map, so the assertions below are not vacuous", () => {
    /*
     * Pinned because the map is read by regex. If it were renamed or reshaped,
     * an empty result would make every assertion below pass by having nothing
     * to check — which is exactly the failure mode this file exists to prevent
     * in the product.
     */
    expect(Object.keys(ACCEPT).length).toBeGreaterThan(1)
    expect(ACCEPT.video).toBe("video/mp4")
  })

  it.each(Object.entries(acceptMap()))(
    "the events folder accepts every content type offered for %s",
    (kind, accepts) => {
      for (const contentType of accepts.split(",").map((s) => s.trim())) {
        if (contentType in KNOWN_UNRENDERED) continue
        expect({ kind, contentType, allowed: validateContentType(contentType, "events") }).toEqual({
          kind,
          contentType,
          allowed: true,
        })
      }
    }
  )

  it("does not quietly accept a format nothing can render", () => {
    // The other direction: the exclusion list has to stay a list of real gaps.
    for (const contentType of Object.keys(KNOWN_UNRENDERED)) {
      expect(validateContentType(contentType, "events")).toBe(false)
    }
  })
})
