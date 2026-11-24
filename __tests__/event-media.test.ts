import { MEDIA } from "@/lib/constants"
import { eventMediaRows } from "@/lib/event-media"
import { clipTooLong, mediaSize } from "@/lib/media-size"
import { eventWriteSchema } from "@/lib/validations/event"

/**
 * Media size on `event_media` (SCRUM-1066, queue task 20): `width`, `height`
 * and, for a clip, `duration_ms`, measured by the dashboard from the file the
 * organizer picked, so the app can choose a card's fit before the bytes land.
 */
const clip = {
  type: "video" as const,
  url: "https://media.example.com/clip.mp4",
  thumbnail_url: "https://media.example.com/clip-poster.jpg",
}

const parseMedia = (item: Record<string, unknown>) =>
  eventWriteSchema.safeParse({ media_items: [item] })

describe("media item size, on the write", () => {
  it("accepts a clip with its size and length", () => {
    expect(parseMedia({ ...clip, width: 1080, height: 1920, duration_ms: 12_400 }).success).toBe(true)
  })

  it("accepts an item with no size at all (a pasted URL, or a row from before)", () => {
    expect(parseMedia(clip).success).toBe(true)
    expect(parseMedia({ ...clip, width: null, height: null, duration_ms: null }).success).toBe(true)
  })

  it("refuses a width without a height, and the reverse", () => {
    expect(parseMedia({ ...clip, width: 1080 }).success).toBe(false)
    expect(parseMedia({ ...clip, height: 1080 }).success).toBe(false)
  })

  it("refuses a zero, negative, fractional or absurd side", () => {
    for (const side of [0, -1, 10.5, MEDIA.MAX_SIDE_PX + 1]) {
      expect(parseMedia({ ...clip, width: side, height: 1080 }).success).toBe(false)
    }
  })

  it("refuses a clip past 15.5 seconds, in words that say 15", () => {
    const result = parseMedia({ ...clip, duration_ms: 15_501 })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe("Clips play up to 15 seconds")
  })

  it("accepts a '15 second' export, which often measures a little over (decided per advisor)", () => {
    expect(parseMedia({ ...clip, duration_ms: 15_000 }).success).toBe(true)
    expect(parseMedia({ ...clip, duration_ms: 15_500 }).success).toBe(true)
    expect(clipTooLong(15_500)).toBe(false)
    expect(clipTooLong(15_501)).toBe(true)
  })

  it("stores the measured length, never a clamped one", () => {
    expect(eventMediaRows([{ ...clip, duration_ms: 15_400 }])[0].duration_ms).toBe(15_400)
  })

  it("refuses a zero or fractional length", () => {
    expect(parseMedia({ ...clip, duration_ms: 0 }).success).toBe(false)
    expect(parseMedia({ ...clip, duration_ms: 1.5 }).success).toBe(false)
  })
})

describe("eventMediaRows", () => {
  it("writes the size of a clip and its length", () => {
    const [row] = eventMediaRows([{ ...clip, width: 1080, height: 1920, duration_ms: 12_400 }])
    expect(row).toMatchObject({ width: 1080, height: 1920, duration_ms: 12_400 })
  })

  it("drops a length on anything but a clip: the database refuses it", () => {
    const [row] = eventMediaRows([
      { type: "image", url: "https://media.example.com/a.jpg", width: 2048, height: 2048, duration_ms: 3000 },
    ])
    expect(row).toMatchObject({ width: 2048, height: 2048 })
    expect(row).not.toHaveProperty("duration_ms")
  })

  it("leaves the columns out when there is no size, never writing undefined", () => {
    const [row] = eventMediaRows([{ ...clip, width: null, height: null }])
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(["width"]))
    expect(Object.values(row)).not.toContain(undefined)
  })

  it("keeps today's rules: an empty poster is no poster, order falls back to position", () => {
    const rows = eventMediaRows([
      { ...clip, thumbnail_url: "" },
      { ...clip, order: 7 },
    ])
    expect(rows[0]).not.toHaveProperty("thumbnail_url")
    expect(rows[0].order).toBe(0)
    expect(rows[1].order).toBe(7)
  })
})

describe("mediaSize (what the dashboard sends from a picked file)", () => {
  it("gives a still its size and no length", () => {
    expect(mediaSize(2048, 1536)).toEqual({ width: 2048, height: 1536 })
  })

  it("gives a clip its length in whole milliseconds", () => {
    expect(mediaSize(1080, 1920, 12.3456)).toEqual({ width: 1080, height: 1920, duration_ms: 12346 })
  })

  it("leaves out a length the browser cannot tell (a live stream reports Infinity)", () => {
    expect(mediaSize(1080, 1920, Infinity)).toEqual({ width: 1080, height: 1920 })
    expect(mediaSize(1080, 1920, NaN)).toEqual({ width: 1080, height: 1920 })
  })

  it("is nothing when the file decoded to no picture", () => {
    expect(mediaSize(0, 0, 4)).toBeNull()
  })

  it("is nothing past the side limit: the save must not fail for a panorama", () => {
    expect(mediaSize(MEDIA.MAX_SIDE_PX + 1, 400)).toBeNull()
    expect(mediaSize(MEDIA.MAX_SIDE_PX, 400)).toEqual({ width: MEDIA.MAX_SIDE_PX, height: 400 })
  })
})

/**
 * The focal point (SCRUM-1106, queue task 30): where the subject is, 0–1 of
 * the picture from its left and top, both or neither. Picked in the dashboard;
 * the app crops a clip (and a still within rule B's ±15%) around it.
 */
describe("media item focal point, on the write", () => {
  it("accepts a point inside the picture, its corners included", () => {
    expect(parseMedia({ ...clip, focal_x: 0.62, focal_y: 0.4 }).success).toBe(true)
    expect(parseMedia({ ...clip, focal_x: 0, focal_y: 1 }).success).toBe(true)
  })

  it("accepts no point (the app's default focus)", () => {
    expect(parseMedia({ ...clip, focal_x: null, focal_y: null }).success).toBe(true)
  })

  it("refuses half a point", () => {
    expect(parseMedia({ ...clip, focal_x: 0.5 }).success).toBe(false)
    expect(parseMedia({ ...clip, focal_y: 0.5 }).success).toBe(false)
  })

  it("refuses a point outside the picture", () => {
    for (const v of [-0.01, 1.01, Number.NaN]) {
      expect(parseMedia({ ...clip, focal_x: v, focal_y: 0.5 }).success).toBe(false)
      expect(parseMedia({ ...clip, focal_x: 0.5, focal_y: v }).success).toBe(false)
    }
  })

  it("writes the point when both halves are there, and leaves both columns out otherwise", () => {
    expect(eventMediaRows([{ ...clip, focal_x: 0.62, focal_y: 0 }])[0]).toMatchObject({ focal_x: 0.62, focal_y: 0 })
    const [none] = eventMediaRows([{ ...clip, focal_x: 0.62, focal_y: null }])
    expect(none).not.toHaveProperty("focal_x")
    expect(none).not.toHaveProperty("focal_y")
  })
})

/** A clip's copies (SCRUM-1106): only on a clip, exactly their four keys, round-tripped by the editor. */
describe("media item renditions, on the write", () => {
  const copy = { url: "https://media.example.com/small.mp4", width: 540, height: 960, bytes: 1_500_000 }

  it("accepts a checked clip's copies, and none", () => {
    expect(parseMedia({ ...clip, renditions: [copy] }).success).toBe(true)
    expect(parseMedia({ ...clip, renditions: null }).success).toBe(true)
  })

  it("refuses a copy that is not a sized https file, and more than four", () => {
    for (const bad of [{ ...copy, url: "http://media.example.com/a.mp4" }, { ...copy, width: 0 }, { ...copy, bytes: 1.5 }, { url: copy.url }]) {
      expect(parseMedia({ ...clip, renditions: [bad] }).success).toBe(false)
    }
    expect(parseMedia({ ...clip, renditions: Array(5).fill(copy) }).success).toBe(false)
  })

  it("writes only the four keys, on a clip, and leaves the column out otherwise", () => {
    expect(eventMediaRows([{ ...clip, renditions: [{ ...copy, extra: 1 } as typeof copy] }])[0].renditions).toEqual([copy])
    for (const item of [{ ...clip, renditions: [] }, { ...clip, renditions: null }, { ...clip, type: "image" as const, renditions: [copy] }]) {
      expect(eventMediaRows([item])[0]).not.toHaveProperty("renditions")
    }
  })
})
