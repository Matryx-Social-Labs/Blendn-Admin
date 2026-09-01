import { isSameSponsorName, normaliseSponsorName } from "@/lib/sponsor-name"
import { placementIsRunnable, placementPhase } from "@/lib/placement-phase"
import { SPONSORSHIP } from "@/lib/constants"

/**
 * The two pure modules behind sponsorship, where the subtle bugs live.
 *
 * Both are small enough to look obviously correct and are not: the name key has
 * to collapse the right things and refuse to collapse the wrong ones, and the
 * phase has to stay derived rather than drifting into a stored value.
 */

describe("normaliseSponsorName — a search key, never an identity", () => {
  it("collapses the duplicate the picker exists to catch", () => {
    // The actual case: three organisers, three spellings, three rows.
    const forms = ["Red Bull", "RedBull", "red-bull", "  RED  BULL  ", "Red.Bull"]
    const keys = new Set(forms.map(normaliseSponsorName))
    expect(keys.size).toBe(1)
    expect([...keys][0]).toBe("redbull")
  })

  it("folds accents, because a phone keyboard produces both", () => {
    expect(normaliseSponsorName("Café Noir")).toBe(normaliseSponsorName("Cafe Noir"))
  })

  it("strips ampersands and punctuation", () => {
    expect(normaliseSponsorName("AT&T")).toBe("att")
    expect(normaliseSponsorName("Ben & Jerry's")).toBe("benjerrys")
  })

  it("keeps digits, which are part of real brand names", () => {
    expect(normaliseSponsorName("Studio 54")).toBe("studio54")
  })

  it("does NOT treat two unusable names as the same brand", () => {
    /*
     * "!!!" and "???" both normalise to the empty string. Calling them equal
     * would let one junk row block another from being created, and would make
     * the per-org unique index fire on unrelated garbage.
     */
    expect(normaliseSponsorName("!!!")).toBe("")
    expect(isSameSponsorName("!!!", "???")).toBe(false)
  })

  it("is honest that it over-collapses, which is why nothing auto-merges", () => {
    // Documented behaviour, asserted so nobody "fixes" it into an identity.
    // AT&T and a hypothetical "ATT" are indistinguishable here by design; the
    // merge UI shows website and claim status so a human decides.
    expect(isSameSponsorName("AT&T", "ATT")).toBe(true)
  })
})

describe("placementPhase — derived, so it cannot disagree with the clock", () => {
  const event = {
    start_time: new Date("2026-08-20T20:00:00Z"),
    end_time: new Date("2026-08-21T02:00:00Z"),
  }
  const before = new Date("2026-08-20T12:00:00Z")
  const during = new Date("2026-08-20T23:00:00Z")
  const after = new Date("2026-08-22T00:00:00Z")

  it("passes non-approved statuses through untouched", () => {
    // These describe the agreement, not the clock. A cancelled placement at a
    // live event is cancelled, not live.
    for (const status of ["draft", "proposed", "cancelled"] as const) {
      expect(placementPhase({ status }, event, during)).toBe(status)
    }
  })

  it("derives upcoming, live and ended from the event's own times", () => {
    expect(placementPhase({ status: "approved" }, event, before)).toBe("upcoming")
    expect(placementPhase({ status: "approved" }, event, during)).toBe("live")
    expect(placementPhase({ status: "approved" }, event, after)).toBe("ended")
  })

  it("treats the exact start and end instants as inside the event", () => {
    // The boundary a sweeper would get wrong by up to its tick interval.
    expect(placementPhase({ status: "approved" }, event, event.start_time)).toBe("live")
    expect(placementPhase({ status: "approved" }, event, event.end_time)).toBe("live")
  })

  it("is runnable before doors, because the room opens early", () => {
    /*
     * Not the same question as "live". A campaign is armed before doors so its
     * first send can land as the room opens, and since #262 the room opens
     * before the event for people who said they are coming.
     */
    expect(placementIsRunnable({ status: "approved" }, event, before)).toBe(true)
    expect(placementIsRunnable({ status: "approved" }, event, during)).toBe(true)
    expect(placementIsRunnable({ status: "approved" }, event, after)).toBe(false)
  })

  it("is never runnable on an unapproved or cancelled placement", () => {
    for (const status of ["draft", "proposed", "cancelled"] as const) {
      expect(placementIsRunnable({ status }, event, during)).toBe(false)
    }
  })
})

describe("SPONSORSHIP constants", () => {
  it("floors a campaign interval at the room gap, not below it", () => {
    // A campaign allowed to run faster than the room's global gap would be
    // permanently throttled by the scheduler, which is a confusing way to
    // express a rule twice.
    expect(SPONSORSHIP.MIN_INTERVAL_MINUTES).toBeGreaterThanOrEqual(
      SPONSORSHIP.ROOM_MIN_GAP_MINUTES
    )
  })

  it("keeps the privacy floor above 1, or it is not a floor", () => {
    expect(SPONSORSHIP.MIN_REPORTABLE).toBeGreaterThan(1)
  })
})
