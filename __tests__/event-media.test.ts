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
})
