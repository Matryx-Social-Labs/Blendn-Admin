import {
  recordImpressions,
  exposuresFor,
  resetExposureMemory,
} from "@/lib/exposure"

/**
 * Attention already received, so the room's remaining attention can go
 * somewhere else.
 *
 * Ranking is deterministic, so without this the highest-scoring person in a
 * room is shown first to everyone, collects every like, and nobody else gets
 * any. Worse here than on a dating app: the pool is one room on one night and
 * does not refill.
 *
 * These exercise the in-process path deliberately — `REDIS_URL` is unset in the
 * test environment, which is also how the app runs at one replica. The Redis
 * path is the same arithmetic behind an `INCR`.
 */
const EVENT = "11111111-1111-4111-8111-111111111111"

beforeEach(() => {
  resetExposureMemory()
})

describe("impression counters", () => {
  it("starts everybody at zero", async () => {
    const counts = await exposuresFor(EVENT, ["a", "b"])
    expect(counts.get("a")).toBe(0)
    expect(counts.get("b")).toBe(0)
  })

  it("counts each time somebody is shown", async () => {
    await recordImpressions(EVENT, ["a", "b"])
    await recordImpressions(EVENT, ["a"])

    const counts = await exposuresFor(EVENT, ["a", "b"])
    expect(counts.get("a")).toBe(2)
    expect(counts.get("b")).toBe(1)
  })

  it("keeps events apart", async () => {
    /*
     * Counters are per event-night. Somebody popular last Friday starts the
     * next room level with everyone else — the damping is about spreading
     * attention within one room, not about a reputation that follows people.
     */
    const other = "22222222-2222-4222-8222-222222222222"
    await recordImpressions(EVENT, ["a"])

    expect((await exposuresFor(other, ["a"])).get("a")).toBe(0)
    expect((await exposuresFor(EVENT, ["a"])).get("a")).toBe(1)
  })

  it("does nothing, loudly or quietly, for an empty deck", async () => {
    await expect(recordImpressions(EVENT, [])).resolves.toBeUndefined()
    expect((await exposuresFor(EVENT, [])).size).toBe(0)
  })

  it("never throws, because a ranking heuristic must not break the deck", async () => {
    /*
     * The whole store is best-effort. An impression that goes unrecorded costs
     * a little balancing accuracy; a deck that fails to render costs the
     * feature. Both entry points swallow their own errors.
     */
    await expect(recordImpressions(EVENT, ["a"])).resolves.not.toThrow()
    await expect(exposuresFor(EVENT, ["a"])).resolves.toBeInstanceOf(Map)
  })
})
