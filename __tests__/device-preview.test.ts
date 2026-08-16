import { readFileSync } from "fs"
import { join } from "path"

/**
 * The device preview — the numbers it draws must be the ones the app crops to.
 *
 * `docs/MEDIA.md` is the source, and it is already pinned to the *form copy*
 * by `media-guidance.test.ts`. This pins the *geometry*, which is the half that
 * silently lies: a preview drawing the wrong safe area is worse than no
 * preview, because an organiser trusts it and composes to it.
 */
const SRC = () =>
  readFileSync(join(__dirname, "..", "components", "event-form", "device-preview.tsx"), "utf8")
const MEDIA_DOC = () => readFileSync(join(__dirname, "..", "docs", "MEDIA.md"), "utf8")

describe("the preview crops to the slots the app actually uses", () => {
  it("takes all three aspects from the frame's measurements", () => {
    const src = SRC()
    // Frame 1141:4644, as recorded in docs/MEDIA.md.
    expect(src).toContain("331.5 / 450")
    expect(src).toContain("318 / 165.38")
    expect(src).toContain("366 / 342")
  })

  it("agrees with docs/MEDIA.md on the safe area", () => {
    /*
     * 73.7% x 52% — the region surviving *every* crop. The doc derives it: the
     * portrait slot keeps full height and cuts to 73.7% of the width, the wide
     * slot keeps full width and cuts to 52% of the height.
     */
    const doc = MEDIA_DOC()
    expect(doc).toContain("73.7%")
    expect(doc).toContain("52%")
    const src = SRC()
    expect(src).toContain("const SAFE_W = 0.737")
    expect(src).toContain("const SAFE_H = 0.52")
  })

  it("derives the aspects from the same numbers the doc quotes", () => {
    // The doc rounds to three places; the component divides. They must agree.
    expect(331.5 / 450).toBeCloseTo(0.737, 3)
    expect(318 / 165.38).toBeCloseTo(1.923, 3)
    expect(366 / 342).toBeCloseTo(1.07, 3)
  })

  it("clamps the safe box rather than overflowing its crop", () => {
    /*
     * A slot can crop tighter than the safe area on one axis — the featured
     * slot already cuts to 73.7% of the width, so the box spans the whole
     * width there. Without the clamp the overlay would draw outside its own
     * frame and read as a rendering fault.
     */
    const src = SRC()
    expect(src).toContain("Math.min(1, SAFE_W / shownW)")
    expect(src).toContain("Math.min(1, SAFE_H / shownH)")
  })

  it("is shown for the cover and for gallery images", () => {
    // The feed cycles the whole media set on an active card, so a gallery
    // image has to survive the featured slot exactly as the cover does.
    const cover = readFileSync(
      join(__dirname, "..", "components", "event-form", "cover-image-section.tsx"), "utf8")
    const media = readFileSync(
      join(__dirname, "..", "components", "event-form", "media-section.tsx"), "utf8")
    expect(cover).toContain("<DevicePreview")
    expect(media).toContain("<DevicePreview")
  })
})
