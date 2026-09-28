import { eventClock, eventStateFor, livePhaseFor, publishBlockers } from "@/lib/event-phase"

/**
 * The four states the Overview is designed around.
 *
 * The screen used to mean one thing always — it was the edit form — so opening
 * an event to see how it was doing asked "what did you type" rather than "is
 * this working". Each state now asks a different question, and getting the
 * state wrong asks the wrong one.
 */

const base = {
  status: "published",
  start_time: new Date("2026-06-10T18:00:00Z"),
  end_time: new Date("2026-06-10T23:00:00Z"),
}

describe("livePhaseFor", () => {
  it("splits on the event's own schedule", () => {
    expect(livePhaseFor("2026-06-10T18:00:00Z", "2026-06-10T23:00:00Z", new Date("2026-06-10T12:00:00Z"))).toBe("pre")
    expect(livePhaseFor("2026-06-10T18:00:00Z", "2026-06-10T23:00:00Z", new Date("2026-06-10T20:00:00Z"))).toBe("live")
    expect(livePhaseFor("2026-06-10T18:00:00Z", "2026-06-10T23:00:00Z", new Date("2026-06-11T02:00:00Z"))).toBe("post")
  })

  it("counts the exact start and end as live, not either side", () => {
    // A door opening at 18:00:00 sharp should not read as "not started".
    expect(livePhaseFor("2026-06-10T18:00:00Z", "2026-06-10T23:00:00Z", new Date("2026-06-10T18:00:00Z"))).toBe("live")
    expect(livePhaseFor("2026-06-10T18:00:00Z", "2026-06-10T23:00:00Z", new Date("2026-06-10T23:00:00Z"))).toBe("live")
  })
})

describe("eventStateFor", () => {
  it("maps the schedule onto upcoming / live / over", () => {
    expect(eventStateFor(base, new Date("2026-06-10T12:00:00Z"))).toBe("upcoming")
    expect(eventStateFor(base, new Date("2026-06-10T20:00:00Z"))).toBe("live")
    expect(eventStateFor(base, new Date("2026-06-11T02:00:00Z"))).toBe("over")
  })

  it("keeps a draft a draft even once its start time has passed", () => {
    // Asking "will it fill?" of something nobody can see would be nonsense.
    expect(eventStateFor({ ...base, status: "draft" }, new Date("2026-06-10T20:00:00Z"))).toBe("draft")
    expect(eventStateFor({ ...base, status: "draft" }, new Date("2026-07-01T00:00:00Z"))).toBe("draft")
  })

  it("treats cancelled and completed as over, whatever the clock says", () => {
    // A cancelled event has no future to pace towards, but its RSVPs are still
    // worth looking at.
    expect(eventStateFor({ ...base, status: "cancelled" }, new Date("2026-06-01T00:00:00Z"))).toBe("over")
    expect(eventStateFor({ ...base, status: "completed" }, new Date("2026-06-01T00:00:00Z"))).toBe("over")
  })
})

describe("publishBlockers", () => {
  const ready = {
    title: "Warehouse Friday",
    description: "A proper night out with three rooms and a rooftop.",
    start_time: new Date("2026-06-10T18:00:00Z"),
    end_time: new Date("2026-06-10T23:00:00Z"),
    latitude: 12.97,
    longitude: 77.59,
    venue_name: "Toit",
    venue_id: null,
    max_capacity: 200,
    cover_image_url: "https://example.com/cover.jpg",
    categoryCount: 2,
  }

  it("finds nothing wrong with a complete event", () => {
    expect(publishBlockers(ready)).toEqual([])
  })

  it("blocks on missing coordinates, and says why it matters", () => {
    // The hard one. Check-in is GPS-gated, so publishing without coordinates
    // produces an event nobody can attend — which reads as the app being
    // broken rather than the event being unfinished.
    const found = publishBlockers({ ...ready, latitude: null, longitude: null })
    const location = found.find((b) => b.key === "location")
    expect(location?.blocking).toBe(true)
    expect(location?.hint).toMatch(/check in/i)
  })

  it("does not treat longitude zero as missing", () => {
    // The truthiness bug that once disabled a geofence entirely.
    expect(publishBlockers({ ...ready, longitude: 0 }).some((b) => b.key === "location")).toBe(false)
  })

  it("accepts a linked venue with no free-text name", () => {
    expect(
      publishBlockers({ ...ready, venue_name: null, venue_id: "venue_1" }).some(
        (b) => b.key === "venue"
      )
    ).toBe(false)
  })

  it("blocks when neither venue field is set", () => {
    expect(
      publishBlockers({ ...ready, venue_name: null, venue_id: null }).some(
        (b) => b.key === "venue"
      )
    ).toBe(true)
  })

  it("blocks an event that ends before it starts", () => {
    const found = publishBlockers({ ...ready, end_time: new Date("2026-06-10T17:00:00Z") })
    expect(found.find((b) => b.key === "schedule")?.blocking).toBe(true)
  })

  it("treats cover, categories and capacity as advice, not blockers", () => {
    // Nudging is right; refusing to publish over a missing cover image is not.
    const found = publishBlockers({
      ...ready,
      cover_image_url: null,
      categoryCount: 0,
      max_capacity: null,
    })
    expect(found).toHaveLength(3)
    expect(found.every((b) => !b.blocking)).toBe(true)
  })

  it("counts only blocking items towards being unpublishable", () => {
    const found = publishBlockers({ ...ready, cover_image_url: null })
    expect(found.some((b) => b.blocking)).toBe(false)
  })
})

describe("an event's times are told in its own timezone (SCRUM-421)", () => {
  // Jest runs in UTC, as Railway does. A 04:30 IST start is 23:00Z the day before.
  const start = new Date("2026-09-28T23:00:00Z")
  const end = new Date("2026-09-29T01:00:00Z")
  const ist = eventClock("Asia/Kolkata")

  it("formats in the event's zone, not the server's", () => {
    expect(ist.time(start)).toBe("04:30")
    expect(ist.time(end)).toBe("06:30")
    expect(ist.day(start)).toMatch(/^29 Sep/)
    expect(ist.dateTime(start)).toMatch(/^29 Sept? 2026, 04:30$/)
  })

  it("counts days to the doors by the event's calendar, not by 24-hour blocks", () => {
    // Three minutes before the doors is today, not "in 1 day".
    expect(ist.daysUntil(start, new Date("2026-09-28T22:57:00Z"))).toBe(0)
    // 23:30 IST on the 28th: the doors are tomorrow, five hours away.
    expect(ist.daysUntil(start, new Date("2026-09-28T18:00:00Z"))).toBe(1)
    expect(ist.daysUntil(start, new Date("2026-09-25T12:00:00Z"))).toBe(4)
  })

  it("falls back to UTC for a zone the runtime does not know, rather than throwing", () => {
    expect(eventClock("Not/AZone").time(start)).toBe("23:00")
  })
})
