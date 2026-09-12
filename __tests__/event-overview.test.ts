/*
 * The event page's hero and tiles, per lifecycle state.
 *
 * `getEventOverview` feeds every organiser's event page and had no test of
 * any kind — one structural guard checked that the source *mentions*
 * `distinctAttendees(`. Eight hero/tile branches were unexercised, and one
 * of them was wrong: a truthy check on capacity rendered "no capacity set"
 * beside a tile saying "Capacity 0".
 */
const mockDb = {
  events: { findUnique: jest.fn() },
  event_rsvps: { count: jest.fn() },
  event_check_ins: { count: jest.fn(), findMany: jest.fn() },
  event_ratings: { findMany: jest.fn() },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

import { getEventOverview } from "@/lib/event-overview"

const HOUR = 3_600_000
const baseEvent = {
  id: "e1",
  title: "Sunset Sessions",
  description: "Filter coffee and founders on a rooftop.",
  status: "published",
  start_time: new Date(Date.now() + 48 * HOUR),
  end_time: new Date(Date.now() + 51 * HOUR),
  latitude: 12.9 as number | null,
  longitude: 77.5 as number | null,
  venue_name: "The Humming Tree",
  venue_id: null,
  max_capacity: null as number | null,
  check_in_radius: 60,
  cover_image_url: null,
  _count: { categories: 1, favorites: 3 },
}

function arrange(opts: {
  event?: Partial<typeof baseEvent>
  going?: number
  maybe?: number
  checkedInNow?: number
  attended?: Array<{ user_id: string; kind: string }>
  ratings?: number[]
}) {
  mockDb.events.findUnique.mockResolvedValue({ ...baseEvent, ...opts.event })
  mockDb.event_rsvps.count
    .mockReset()
    .mockResolvedValueOnce(opts.going ?? 0)
    .mockResolvedValueOnce(opts.maybe ?? 0)
  mockDb.event_check_ins.count.mockResolvedValue(opts.checkedInNow ?? 0)
  mockDb.event_check_ins.findMany.mockResolvedValue(opts.attended ?? [])
  mockDb.event_ratings.findMany.mockResolvedValue((opts.ratings ?? []).map((rating) => ({ rating })))
}

describe("getEventOverview — upcoming", () => {
  it("the hero counts people going, with maybe and saved beside it, when there is no capacity", async () => {
    arrange({ going: 12, maybe: 4 })
    const o = await getEventOverview("e1")
    expect(o?.state).toBe("upcoming")
    expect(o?.hero).toEqual({ label: "Going", value: "12", hint: "no capacity set · 4 maybe · 3 saved" })
    expect(o?.tiles.map((t) => t.label)).toEqual(["Capacity", "Checked in", "Room opens", "Check-in fence"])
    expect(o?.tiles[0].value).toBeNull()
    expect(o?.tiles[3].value).toBe("60 m")
  })

  it("says fill when a capacity is set", async () => {
    arrange({ event: { max_capacity: 50 }, going: 25, maybe: 0 })
    const o = await getEventOverview("e1")
    expect(o?.hero.hint).toBe("of 50 · 50% full · 0 maybe · 3 saved")
    expect(o?.tiles[0].value).toBe("50")
  })

  it("treats a capacity of 0 as set, not absent — the tile below says 0", async () => {
    arrange({ event: { max_capacity: 0 }, going: 2 })
    const o = await getEventOverview("e1")
    expect(o?.tiles[0].value).toBe("0")
    expect(o?.hero.hint).not.toContain("no capacity set")
    expect(o?.hero.hint).toContain("capacity 0")
  })
})

describe("getEventOverview — over", () => {
  const over = { start_time: new Date(Date.now() - 30 * HOUR), end_time: new Date(Date.now() - 27 * HOUR) }

  it("turn-up is people who came against people who said they would", async () => {
    arrange({
      event: over,
      going: 4,
      attended: [
        { user_id: "a", kind: "attendee" },
        { user_id: "a", kind: "attendee" }, // a second day for the same person
        { user_id: "b", kind: "attendee" },
        { user_id: "s", kind: "staff" },
      ],
    })
    const o = await getEventOverview("e1")
    expect(o?.state).toBe("over")
    expect(o?.hero).toEqual({ label: "Turned up", value: "50%", hint: "2 of 4 who said they would" })
  })

  it("with nobody RSVP'd the hero is the count of who came, not a percentage of nothing", async () => {
    arrange({ event: over, going: 0, attended: [{ user_id: "a", kind: "attendee" }, { user_id: "b", kind: "attendee" }] })
    const o = await getEventOverview("e1")
    expect(o?.hero).toEqual({ label: "Came", value: "2", hint: "nobody RSVP'd — walk-ins only" })
  })

  it("the rating tile says nobody rated it rather than showing a dash with no reason", async () => {
    arrange({ event: over, going: 1, ratings: [] })
    const o = await getEventOverview("e1")
    const rating = o?.tiles.find((t) => t.label === "Rating")
    expect(rating).toEqual({ label: "Rating", value: null, hint: "nobody rated it" })
  })
})

describe("getEventOverview — draft", () => {
  it("the hero is what blocks publication, and a complete draft says Yes", async () => {
    arrange({ event: { status: "draft" } })
    const o = await getEventOverview("e1")
    expect(o?.state).toBe("draft")
    expect(o?.hero.label).toBe("Ready to publish")
    expect(o?.publishable).toBe(true)
    expect(o?.hero.value).toBe("Yes")
  })

  it("counts what is left when something blocks", async () => {
    arrange({ event: { status: "draft", latitude: null, longitude: null } })
    const o = await getEventOverview("e1")
    expect(o?.publishable).toBe(false)
    expect(o?.hero.value).toMatch(/^\d+ left$/)
    expect(o?.hero.hint).toBe("Nobody can see this yet")
  })
})
