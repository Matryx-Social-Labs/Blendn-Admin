jest.mock("@/lib/db", () => ({ db: {} }))

import { liveCountBucket } from "@/lib/disclosure"
import { goLiveSchema, goLiveWindow, STAY_EXTEND_MINUTES, stayExtension } from "@/lib/go-live"
import { PING_INTERVAL_MINUTES } from "@/lib/presence"
import { PRESENCE_CUTOFF_MINUTES } from "@/lib/presence-sessions"
import { steadyBucket } from "@/lib/live-count"
import { atTheVenue, venueTakeoverWhere } from "@/lib/venue-visibility"

/**
 * Go Live's arithmetic (plan v2 step 4): the windows, the reset, "stay", and
 * the count a watcher may see. The routes are driven in go-live.itest.ts.
 */

const NOW = new Date("2026-10-02T15:00:00Z")
const DAY_END = new Date("2026-10-03T00:30:00Z") // 06:00 IST
const min = (n: number) => new Date(NOW.getTime() + n * 60_000)

describe("goLiveSchema (PL-U02)", () => {
  const at = { latitude: 12.97, longitude: 77.64 }

  it.each([20, 45, 60])("accepts %s minutes", (minutes) => {
    expect(goLiveSchema.safeParse({ ...at, minutes }).success).toBe(true)
  })

  it.each([0, 15, 30, 61, 240, "20"])("refuses %p", (minutes) => {
    expect(goLiveSchema.safeParse({ ...at, minutes }).success).toBe(false)
  })

  it("accepts stay, and refuses a body that chooses nothing", () => {
    expect(goLiveSchema.safeParse({ ...at, stay: true }).success).toBe(true)
    expect(goLiveSchema.safeParse({ ...at, stay: false }).success).toBe(false)
    expect(goLiveSchema.safeParse(at).success).toBe(false)
  })
})

describe("goLiveWindow", () => {
  it("opens the window asked for", () => {
    expect(goLiveWindow({ minutes: 45 }, NOW, DAY_END)).toEqual({ expiresAt: min(45), stay: false, stayUntil: null })
  })

  it("never runs past the reset (D-4), and ends exactly there when the two meet", () => {
    expect(goLiveWindow({ minutes: 60 }, NOW, min(10)).expiresAt).toEqual(min(10))
    expect(goLiveWindow({ minutes: 20 }, NOW, min(20)).expiresAt).toEqual(min(20))
  })

  it("extends a window already open, and never shortens it", () => {
    const open = (at: Date) => ({ expiresAt: at, stayUntil: null })
    expect(goLiveWindow({ minutes: 20 }, NOW, DAY_END, open(min(50))).expiresAt).toEqual(min(50))
    expect(goLiveWindow({ minutes: 60 }, NOW, DAY_END, open(min(5))).expiresAt).toEqual(min(60))
    // The same end asked again: the same end.
    expect(goLiveWindow({ minutes: 20 }, NOW, DAY_END, open(min(20))).expiresAt).toEqual(min(20))
    // A window that somehow runs past the reset is cut to it, never beyond.
    expect(goLiveWindow({ minutes: 20 }, NOW, min(30), open(min(90))).expiresAt).toEqual(min(30))
    // An ended window is no window to keep.
    expect(goLiveWindow({ minutes: 20 }, NOW, DAY_END, open(min(-5))).expiresAt).toEqual(min(20))
  })

  it("opens stay like an hour, capped at four hours or the reset", () => {
    expect(goLiveWindow({ stay: true }, NOW, DAY_END)).toEqual({ expiresAt: min(60), stay: true, stayUntil: min(240) })
    expect(goLiveWindow({ stay: true }, NOW, min(180)).stayUntil).toEqual(min(180))
  })

  it("keeps the first stay's cap when stay is chosen again the same day (D-x5)", () => {
    // Chosen 3 h 50 m ago: ten minutes left on the cap, whatever is tapped now.
    const again = goLiveWindow({ stay: true }, NOW, DAY_END, { expiresAt: min(5), stayUntil: min(10) })
    expect(again).toEqual({ expiresAt: min(10), stay: true, stayUntil: min(10) })
  })

  it("switches stay to a fixed window without a cap, and keeps the cap for a later stay (D-x5)", () => {
    const fixed = goLiveWindow({ minutes: 60 }, NOW, DAY_END, { expiresAt: min(5), stayUntil: min(30) })
    expect(fixed).toEqual({ expiresAt: min(60), stay: false, stayUntil: min(30) })
    // Back to stay: the open hour is kept (never shortened), the old cap stands.
    const back = goLiveWindow({ stay: true }, min(1), DAY_END, { expiresAt: fixed.expiresAt, stayUntil: fixed.stayUntil })
    expect(back).toEqual({ expiresAt: min(60), stay: true, stayUntil: min(30) })
    expect(stayExtension({ ...back }, min(45))).toBeNull()
  })
})

describe("stayExtension (PL-U03)", () => {
  const stay = (expiresAt: Date, stayUntil: Date | null) => ({ expiresAt, stay: true, stayUntil })

  it("carries a stay window past the next ping and the presence cutoff", () => {
    expect(STAY_EXTEND_MINUTES).toBeGreaterThanOrEqual(PING_INTERVAL_MINUTES + PRESENCE_CUTOFF_MINUTES)
    expect(stayExtension(stay(min(3), min(200)), NOW)).toEqual(min(STAY_EXTEND_MINUTES))
  })

  it("does nothing for a fixed window, even one that keeps a cap from an earlier stay", () => {
    expect(stayExtension({ expiresAt: min(3), stay: false, stayUntil: null }, NOW)).toBeNull()
    expect(stayExtension({ expiresAt: min(3), stay: false, stayUntil: min(200) }, NOW)).toBeNull()
  })

  it("does not revive a window that already ended, or that ends this instant", () => {
    expect(stayExtension(stay(min(-1), min(200)), NOW)).toBeNull()
    expect(stayExtension(stay(NOW, min(200)), NOW)).toBeNull()
  })

  it("stops at the cap, and never moves the end earlier", () => {
    expect(stayExtension(stay(min(3), min(8)), NOW)).toEqual(min(8))
    expect(stayExtension(stay(min(40), min(200)), NOW)).toBeNull()
  })
})

describe("liveCountBucket (D-19, D-x2)", () => {
  it.each([
    [0, "quiet"],
    [1, "quiet"],
    [4, "quiet"],
    [5, "5-9"],
    [9, "5-9"],
    [10, "10-19"],
    [19, "10-19"],
    [20, "20+"],
    [480, "20+"],
  ] as const)("%s → %s", (count, bucket) => {
    expect(liveCountBucket(count)).toBe(bucket)
  })

  it("never says a number, and never tells nobody from a few", () => {
    for (let n = 0; n < 25; n++) expect(liveCountBucket(n)).not.toMatch(new RegExp(`^${n}$`))
    expect(liveCountBucket(0)).toBe(liveCountBucket(1))
  })
})

describe("steadyBucket (D-x2 hysteresis)", () => {
  it("rises at the edge", () => {
    expect(steadyBucket("quiet", 5)).toBe("5-9")
    expect(steadyBucket("5-9", 10)).toBe("10-19")
  })

  it("falls only once one more person would not hold it there", () => {
    expect(steadyBucket("5-9", 4)).toBe("5-9")
    expect(steadyBucket("5-9", 3)).toBe("quiet")
    expect(steadyBucket("20+", 19)).toBe("20+")
    expect(steadyBucket("20+", 18)).toBe("10-19")
  })

  it("starts from the plain bucket", () => {
    expect(steadyBucket(null, 4)).toBe("quiet")
  })
})

describe("venueTakeoverWhere", () => {
  it("counts a NULL link as linked, spelled out, under AND (F4)", () => {
    const where = venueTakeoverWhere(NOW)
    expect(where.kind).toBe("event")
    expect(where.visibility).toBe("public")
    expect(where.AND).toEqual([{ OR: [{ venue_link_status: null }, { venue_link_status: { not: "disputed" } }] }])
    expect(where.OR).toBeUndefined()
  })

  it("looks an hour ahead by default, and not at all with lead 0", () => {
    const some = (w: ReturnType<typeof venueTakeoverWhere>) =>
      (w.occurrences as { some: { start_time: { lte: Date }; end_time: { gt: Date }; cancelled_at: null } }).some
    expect(some(venueTakeoverWhere(NOW)).start_time.lte).toEqual(min(60))
    expect(some(venueTakeoverWhere(NOW, { leadMinutes: 0 })).start_time.lte).toEqual(NOW)
    expect(some(venueTakeoverWhere(NOW)).cancelled_at).toBeNull()
  })

  it("ignores an event the viewer is too young for (D-3)", () => {
    expect(venueTakeoverWhere(NOW, { viewerAge: 19 }).AND).toContainEqual({ OR: [{ min_age: null }, { min_age: { lte: 19 } }] })
  })
})

describe("atTheVenue (D-x3)", () => {
  const VENUE_AREA = { type: "circle", lat: 12.97, lng: 77.64, radius: 40, buffer: 20 }
  const event = (link: "auto_linked" | "confirmed" | "disputed" | null, lat: number) => ({
    venue_link_status: link,
    geofence: { type: "circle", lat, lng: 77.64, radius: 30, buffer: 20 },
    latitude: lat,
    longitude: 77.64,
  })

  it("takes the venue over when the owner confirmed the link, wherever its pin is", () => {
    expect(atTheVenue(event("confirmed", 13.5), VENUE_AREA)).toBe(true)
  })

  it("takes it over unconfirmed only when the event's area sits at the venue", () => {
    expect(atTheVenue(event("auto_linked", 12.97), VENUE_AREA)).toBe(true)
    expect(atTheVenue(event(null, 12.97), VENUE_AREA)).toBe(true)
    // ~1 km away: a link anybody could have made.
    expect(atTheVenue(event("auto_linked", 12.979), VENUE_AREA)).toBe(false)
  })

  it("needs a venue area to judge an unconfirmed link against", () => {
    expect(atTheVenue(event("auto_linked", 12.97), null)).toBe(false)
  })
})
