jest.mock("@/lib/db", () => ({ db: {} }))

import { liveCountBucket } from "@/lib/disclosure"
import { goLiveSchema, goLiveWindow, STAY_EXTEND_MINUTES, stayExtension } from "@/lib/go-live"
import { PING_INTERVAL_MINUTES } from "@/lib/presence"
import { PRESENCE_CUTOFF_MINUTES } from "@/lib/presence-sessions"
import { venueTakeoverWhere } from "@/lib/venue-visibility"

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
    expect(goLiveWindow({ minutes: 45 }, NOW, DAY_END)).toEqual({ expiresAt: min(45), stayUntil: null })
  })

  it("never runs past the reset (D-4)", () => {
    const resetSoon = min(10)
    expect(goLiveWindow({ minutes: 60 }, NOW, resetSoon).expiresAt).toEqual(resetSoon)
  })

  it("extends a window already open, and never shortens it", () => {
    expect(goLiveWindow({ minutes: 20 }, NOW, DAY_END, min(50)).expiresAt).toEqual(min(50))
    expect(goLiveWindow({ minutes: 60 }, NOW, DAY_END, min(5)).expiresAt).toEqual(min(60))
  })

  it("opens stay like an hour, capped at four hours or the reset", () => {
    expect(goLiveWindow({ stay: true }, NOW, DAY_END)).toEqual({ expiresAt: min(60), stayUntil: min(240) })
    const resetIn3h = min(180)
    expect(goLiveWindow({ stay: true }, NOW, resetIn3h).stayUntil).toEqual(resetIn3h)
  })
})

describe("stayExtension (PL-U03)", () => {
  it("carries a stay window past the next ping and the presence cutoff", () => {
    expect(STAY_EXTEND_MINUTES).toBeGreaterThanOrEqual(PING_INTERVAL_MINUTES + PRESENCE_CUTOFF_MINUTES)
    expect(stayExtension({ expiresAt: min(3), stayUntil: min(200) }, NOW)).toEqual(min(STAY_EXTEND_MINUTES))
  })

  it("does nothing for a fixed window", () => {
    expect(stayExtension({ expiresAt: min(3), stayUntil: null }, NOW)).toBeNull()
  })

  it("does not revive a window that already ended", () => {
    expect(stayExtension({ expiresAt: min(-1), stayUntil: min(200) }, NOW)).toBeNull()
  })

  it("stops at the cap, and never moves the end earlier", () => {
    expect(stayExtension({ expiresAt: min(3), stayUntil: min(8) }, NOW)).toEqual(min(8))
    expect(stayExtension({ expiresAt: min(40), stayUntil: min(200) }, NOW)).toBeNull()
  })
})

describe("liveCountBucket (D-19, F14)", () => {
  it.each([
    [0, "none"],
    [1, "a_few"],
    [4, "a_few"],
    [5, "5-9"],
    [9, "5-9"],
    [10, "10-19"],
    [19, "10-19"],
    [20, "20+"],
    [480, "20+"],
  ] as const)("%s → %s", (count, bucket) => {
    expect(liveCountBucket(count)).toBe(bucket)
  })

  it("never says a number under twenty", () => {
    for (let n = 1; n < 20; n++) expect(liveCountBucket(n)).not.toMatch(new RegExp(`^${n}$`))
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
