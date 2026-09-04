import { PING_INTERVAL_MINUTES, DEPARTURE_ALLOWANCE_MINUTES } from "@/lib/presence"
import { PRESENCE_CUTOFF_MINUTES } from "@/lib/presence-sessions"

/**
 * Two modules own two halves of one question, and the halves have to agree.
 *
 * `lib/presence.ts` decides how often a ping is WRITTEN — at most every
 * `PING_INTERVAL_MINUTES`, because persisting every client sample would be a
 * write per user per two minutes for nothing.
 *
 * `lib/presence-sessions.ts` decides how long a written ping COUNTS — a
 * session is inside only while `last_seen_at` is newer than
 * `PRESENCE_CUTOFF_MINUTES`.
 *
 * If the write interval ever reaches the cutoff, a person who is standing in
 * the room stops being counted between two of their own pings, and occupancy
 * drops toward zero while the room is full. Nothing else in the system would
 * report an error: every individual write succeeds and every individual read
 * is correct, which is precisely the shape of failure that survives review.
 *
 * The two constants live in different files, are edited for unrelated reasons
 * — one to save writes, the other to make occupancy more live — and neither
 * file mentions the other's number. This is the only thing that connects them.
 */
describe("presence timing constants", () => {
  it("has both constants to compare", () => {
    // The control: two undefined values compare as NaN and every assertion
    // below would pass vacuously.
    expect(typeof PING_INTERVAL_MINUTES).toBe("number")
    expect(typeof PRESENCE_CUTOFF_MINUTES).toBe("number")
    expect(PING_INTERVAL_MINUTES).toBeGreaterThan(0)
    expect(PRESENCE_CUTOFF_MINUTES).toBeGreaterThan(0)
  })

  it("writes a heartbeat more often than it expires one", () => {
    expect({
      ping: PING_INTERVAL_MINUTES,
      cutoff: PRESENCE_CUTOFF_MINUTES,
      hint:
        PING_INTERVAL_MINUTES < PRESENCE_CUTOFF_MINUTES
          ? ""
          : "A session is counted as inside only while last_seen_at is newer than the cutoff, " +
            "and last_seen_at only moves when a ping is persisted. With the write interval at " +
            "or above the cutoff, somebody standing in the room stops being counted between " +
            "their own pings and occupancy falls toward zero with no error anywhere.",
    }).toEqual({ ping: PING_INTERVAL_MINUTES, cutoff: PRESENCE_CUTOFF_MINUTES, hint: "" })
  })

  it("leaves room for a missed ping", () => {
    /*
     * Strictly-less-than is not enough on its own: at 9 and 10 a single
     * dropped sample empties the room. One whole missed cycle has to fit
     * inside the cutoff, which is what the client's own policy assumes when
     * it treats a null fix as breaking a run rather than ending one.
     */
    expect(PRESENCE_CUTOFF_MINUTES).toBeGreaterThanOrEqual(PING_INTERVAL_MINUTES * 2)
  })

  it("does not expire a session before the departure allowance has been judged", () => {
    /*
     * `DEPARTURE_ALLOWANCE_MINUTES` (20) is how long someone may be outside
     * the fence before auto-checkout. The cutoff is shorter, deliberately:
     * "inside now" should stop counting a person who has walked out well
     * before the system commits to checking them out. Pinned so the ordering
     * is a decision rather than a coincidence of two numbers.
     */
    expect(PRESENCE_CUTOFF_MINUTES).toBeLessThan(DEPARTURE_ALLOWANCE_MINUTES)
  })
})
