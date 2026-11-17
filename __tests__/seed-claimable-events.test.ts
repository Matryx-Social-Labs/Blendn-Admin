import { EVENTS } from "../scripts/seed-blr-scenarios"
import { clockFor } from "../scripts/seed-city"
import { eventRows } from "../scripts/seed-qa-scale-rows"

/**
 * The claim card (client SCRUM-1074) shows only on a curated, unclaimed, upcoming night (`offersClaim`). Staging had 1
 * of 57 upcoming on 2026-11-17, none in Toronto and an ended one in Vancouver, so the card could not be driven. Every
 * city runs the same scenarios (`forCity`), so 2–3 here is 2–3 in each city, and a refresh keeps them ahead.
 */
const NOW = new Date("2026-11-17T12:00:00.000Z")

describe("scenario seed: claimable nights in every city", () => {
  const claimable = EVENTS.filter((e) => e.curated && !e.curated.claimed && !e.status && !e.visibility && !e.deleted)

  it("has two or three curated, unclaimed, published, public scenarios", () => {
    expect(claimable.length).toBeGreaterThanOrEqual(2)
    expect(claimable.length).toBeLessThanOrEqual(3)
  })

  it.each(["Asia/Kolkata", "America/Toronto", "America/Vancouver"])("each is upcoming on %s's clock, on different days", (zone) => {
    const starts = claimable.map((e) => e.when(clockFor(zone, NOW)).start)
    expect(starts.every((s) => s.getTime() > NOW.getTime())).toBe(true)
    expect(new Set(starts.map((s) => s.toISOString().slice(0, 10))).size).toBe(starts.length)
  })

  it("keeps the claimed control: a curated night its organiser claimed is not claimable", () => {
    expect(EVENTS.some((e) => e.curated?.claimed === true)).toBe(true)
  })
})

describe("scale seed: a few claimable nights", () => {
  const { specs, events } = eventRows(NOW, "host", "system")
  const curated = events.filter((e) => e.curated_at)

  it("marks three upcoming nights curated and unclaimed (curated_at set, claimed_at null)", () => {
    expect(curated).toHaveLength(3)
    for (const e of curated) {
      expect(e.claimed_at ?? null).toBeNull()
      expect(e.status).toBe("published")
      expect(new Date(e.start_time as Date).getTime()).toBeGreaterThan(NOW.getTime())
    }
  })

  it("never a past night or a venue day (control)", () => {
    const bySlug = new Map(specs.map((s) => [s.slug, s]))
    for (const e of curated) expect(bySlug.get(e.slug as string)?.kind).toBe("event")
    expect(events.filter((e) => e.kind === "venue_day" && e.curated_at)).toHaveLength(0)
  })
})
