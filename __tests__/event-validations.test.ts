import { SPONSORSHIP } from "@/lib/constants"
import {
  sponsoredMessageCreateSchema,
  sponsoredMessageUpdateSchema,
  announcementSchema,
  SPONSORED_MESSAGE_INTERVALS,
} from "@/lib/validations/event"

describe("sponsoredMessageUpdateSchema", () => {
  it("rejects a non-string content instead of crashing on .trim()", () => {
    // PATCH {"content": 123} previously reached `content.trim()` and returned a
    // 500. It must be a 400.
    const result = sponsoredMessageUpdateSchema.safeParse({ content: 123 })
    expect(result.success).toBe(false)
  })

  it("rejects content that is only whitespace", () => {
    expect(sponsoredMessageUpdateSchema.safeParse({ content: "   " }).success).toBe(false)
  })

  it("trims content so the route never has to", () => {
    const result = sponsoredMessageUpdateSchema.safeParse({ content: "  hello  " })
    expect(result.success).toBe(true)
    expect(result.success && result.data.content).toBe("hello")
  })

  it("accepts a partial update — every field is optional", () => {
    expect(sponsoredMessageUpdateSchema.safeParse({}).success).toBe(true)
    expect(sponsoredMessageUpdateSchema.safeParse({ is_active: true }).success).toBe(true)
  })

  it("rejects a non-boolean is_active", () => {
    expect(sponsoredMessageUpdateSchema.safeParse({ is_active: "yes" }).success).toBe(false)
  })

  it("rejects an interval outside the allowed set", () => {
    expect(sponsoredMessageUpdateSchema.safeParse({ interval_minutes: 7 }).success).toBe(false)
    expect(sponsoredMessageUpdateSchema.safeParse({ interval_minutes: 1 }).success).toBe(false)
  })

  it("accepts every documented interval", () => {
    for (const interval of SPONSORED_MESSAGE_INTERVALS) {
      expect(
        sponsoredMessageUpdateSchema.safeParse({ interval_minutes: interval }).success
      ).toBe(true)
    }
  })
})

describe("sponsoredMessageCreateSchema", () => {
  const SPONSOR = "11111111-2222-4333-8444-555555555555"

  it("requires content, interval and a brand", () => {
    expect(sponsoredMessageCreateSchema.safeParse({ content: "hi" }).success).toBe(false)
    expect(sponsoredMessageCreateSchema.safeParse({ interval_minutes: 30 }).success).toBe(false)
    /*
     * A campaign with no brand is one that can never be switched on:
     * `sponsored_active_needs_sponsor` is a CHECK on `is_active`, so it saves
     * fine and refuses at the switch, after the copy has been written.
     */
    expect(
      sponsoredMessageCreateSchema.safeParse({
        content: "Visit the sponsor booth",
        interval_minutes: 30,
      }).success
    ).toBe(false)
  })

  it("rejects a brand id that is not a uuid", () => {
    expect(
      sponsoredMessageCreateSchema.safeParse({
        sponsor_id: "red-bull",
        content: "Visit the sponsor booth",
        interval_minutes: 30,
      }).success
    ).toBe(false)
  })

  it("accepts a well-formed message", () => {
    const result = sponsoredMessageCreateSchema.safeParse({
      sponsor_id: SPONSOR,
      content: "Visit the sponsor booth",
      interval_minutes: 30,
    })
    expect(result.success).toBe(true)
  })

  it("caps content length", () => {
    const result = sponsoredMessageCreateSchema.safeParse({
      sponsor_id: SPONSOR,
      content: "x".repeat(2001),
      interval_minutes: 30,
    })
    expect(result.success).toBe(false)
  })

  it("will not let a PATCH repoint a campaign at another brand", () => {
    /*
     * `sponsor_id` is omitted from the update schema, not merely optional. Sends
     * already recorded under this campaign would re-attribute to whoever it was
     * pointed at, and the placement check ran against the old brand.
     */
    const result = sponsoredMessageUpdateSchema.safeParse({ sponsor_id: SPONSOR })
    expect(result.success && "sponsor_id" in result.data).toBe(false)
  })

  it("refuses an interval below the room-wide floor", () => {
    // 10 and 15 were on the list, under a 20-minute gap that silently overruled
    // them. A dropdown that promises what the scheduler will not honour is worse
    // than one option fewer.
    for (const interval of [5, 10, 15]) {
      expect(
        sponsoredMessageCreateSchema.safeParse({
          sponsor_id: SPONSOR,
          content: "Visit the sponsor booth",
          interval_minutes: interval,
        }).success
      ).toBe(false)
    }
    expect(Math.min(...SPONSORED_MESSAGE_INTERVALS)).toBe(SPONSORSHIP.MIN_INTERVAL_MINUTES)
  })
})

describe("announcementSchema", () => {
  it("rejects empty and whitespace-only content", () => {
    expect(announcementSchema.safeParse({ content: "" }).success).toBe(false)
    expect(announcementSchema.safeParse({ content: "   " }).success).toBe(false)
  })

  it("rejects a non-string content", () => {
    expect(announcementSchema.safeParse({ content: null }).success).toBe(false)
    expect(announcementSchema.safeParse({ content: { text: "hi" } }).success).toBe(false)
  })

  it("trims and accepts real content", () => {
    const result = announcementSchema.safeParse({ content: "  Doors close at 9  " })
    expect(result.success).toBe(true)
    expect(result.success && result.data.content).toBe("Doors close at 9")
  })
})
