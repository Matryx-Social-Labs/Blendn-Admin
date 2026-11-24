import { readFileSync } from "fs"
import { join } from "path"
import {
  cardFit,
  cropsWithSlack,
  DEFAULT_FOCUS,
  fitFor,
  focalPoint,
  focusPosition,
  MEDIA_CARDS,
} from "@/lib/media-fit"

/**
 * The dashboard's per-card preview and focal picker (SCRUM-1106, queue task 30,
 * option A per advisor). The numbers are the app's: a preview that crops
 * differently from the phone is worse than none, because an organizer trusts it.
 */
const MEDIA_DOC = () => readFileSync(join(__dirname, "..", "docs", "MEDIA.md"), "utf8")

describe("the cards the preview draws", () => {
  it("are the app's five surfaces, at their sizes in points", () => {
    expect(MEDIA_CARDS.map((c) => [c.label, c.width, c.height])).toEqual([
      ["Pulse lead", 345, 256],
      ["Event hero", 345, 345],
      ["Venue hero", 393, 300],
      ["Thumb", 64, 64],
      ["Story card", 1080, 1920],
    ])
  })

  it("agree with docs/MEDIA.md, which no longer quotes the deleted Featured card", () => {
    const doc = MEDIA_DOC()
    for (const c of MEDIA_CARDS) expect(doc).toContain(`| ${c.label} | ${c.width} × ${c.height} |`)
    expect(doc).not.toContain("374 × 508")
    expect(doc).not.toContain("331.5 × 450")
  })
})

describe("fitFor (rule B, the app's `fitFor` in LinkPreviewCard)", () => {
  const lead = { width: 345, height: 256 }

  it("crops a still whose ratio is within 15% of the card's", () => {
    expect(fitFor({ width: 800, height: 600 }, lead)).toBe("cover")
  })

  it("shows a still whole past 15%, and exactly 15% off still crops", () => {
    expect(fitFor({ width: 1000, height: 1000 }, lead)).toBe("contain")
    expect(fitFor({ width: 115, height: 100 }, { width: 100, height: 100 })).toBe("cover")
    expect(fitFor({ width: 116, height: 100 }, { width: 100, height: 100 })).toBe("contain")
  })

  it("never crops a picture of unknown size", () => {
    expect(fitFor(null, lead)).toBe("contain")
    expect(fitFor({ width: 0, height: 0 }, lead)).toBe("contain")
  })
})

describe("cardFit", () => {
  const story = MEDIA_CARDS.find((c) => c.key === "story")!
  const hero = MEDIA_CARDS.find((c) => c.key === "hero")!
  const square = { width: 1080, height: 1080 }
  const wide = { width: 1920, height: 1080 }

  it("fills every card with a clip, whatever its shape (owner 2026-11-18)", () => {
    expect(cardFit(hero, wide, "video")).toBe("cover")
  })

  it("keeps the Story card whole, clip or still", () => {
    expect(cardFit(story, square, "video")).toBe("contain")
    expect(cardFit(story, square, "image")).toBe("contain")
  })

  it("applies rule B to a still", () => {
    expect(cardFit(hero, square, "image")).toBe("cover")
    expect(cardFit(hero, wide, "image")).toBe("contain")
  })
})

describe("focusPosition (the object-position that keeps the point in view)", () => {
  const frame = { width: 100, height: 100 }
  const wide = { width: 200, height: 100 }

  it("centres the point when there is room", () => {
    expect(focusPosition(wide, frame, { x: 0.5, y: 0.5 }).x).toBeCloseTo(50)
    // At 0.62 of a picture drawn 200 wide, the point is at 124; centring it shows 74–174 of 200 → 74%.
    expect(focusPosition(wide, frame, { x: 0.62, y: 0.5 }).x).toBeCloseTo(74)
  })

  it("stops at the edge rather than showing past the picture", () => {
    expect(focusPosition(wide, frame, { x: 0.95, y: 0.5 }).x).toBe(100)
    expect(focusPosition(wide, frame, { x: 0, y: 0.5 }).x).toBe(0)
  })

  it("is the centre on an axis with nothing to crop", () => {
    expect(focusPosition(wide, frame, { x: 0.62, y: 0.1 }).y).toBe(50)
  })

  it("falls back to the app's default focus, 50% across and 40% down", () => {
    expect(DEFAULT_FOCUS).toEqual({ x: 0.5, y: 0.4 })
    const tall = { width: 100, height: 200 }
    // 0.4 of 200 is 80; centring it shows 30–130 of 200 → 30%.
    expect(focusPosition(tall, frame, null).y).toBeCloseTo(30)
  })
})

describe("cropsWithSlack (whether the picker is worth showing)", () => {
  it("is always for a clip: every card but the Story crops it", () => {
    expect(cropsWithSlack({ width: 1080, height: 1080 }, "video")).toBe(true)
  })

  it("is never for a square still: no card cuts anything off it", () => {
    expect(cropsWithSlack({ width: 2048, height: 2048 }, "image")).toBe(false)
  })

  it("is for a 4:3 still, which the Pulse lead and venue hero crop", () => {
    expect(cropsWithSlack({ width: 800, height: 600 }, "image")).toBe(true)
  })

  it("is not for a still of unknown size", () => {
    expect(cropsWithSlack(null, "image")).toBe(false)
  })
})

describe("focalPoint (what a click stores)", () => {
  it("rounds to two places and stays inside the picture", () => {
    expect(focalPoint(0.6249)).toBe(0.62)
    expect(focalPoint(-0.3)).toBe(0)
    expect(focalPoint(1.7)).toBe(1)
  })
})
