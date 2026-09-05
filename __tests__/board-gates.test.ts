import {
  mayReadBoard,
  mayPostToBoard,
  profileIsComplete,
  boardDenialMessage,
  type BoardEntitlement,
  type BoardProfile,
} from "@/lib/board"
import { BOARD } from "@/lib/constants"
import { MIN_INTERESTS_TO_RANK } from "@/lib/interest-coverage"

/**
 * The board's three gates.
 *
 * Reading is cheap and posting is not, and the asymmetry is the point. A
 * favourite is one tap; the ask here — travel with me, share a car, be alone
 * with me — is materially riskier than a message in a crowded room, and it is
 * the one place on this product where two people arrange to meet away from a
 * venue full of witnesses.
 */
const complete: BoardProfile = { name: "Ada", age: 29, interestCount: 3, intentCount: 1 }
const going: BoardEntitlement = { rsvp: "going", favourited: false }
const quiet = { outstandingRequests: 0, requestsThisWeek: 0 }

describe("reading the board", () => {
  it("lets a favouriter in", () => {
    /*
     * Somebody deciding whether to go is exactly who this is for — "is anyone
     * else going alone" is a reason to commit, and requiring the commitment
     * first inverts it.
     */
    expect(mayReadBoard({ rsvp: null, favourited: true })).toBeNull()
  })

  it("lets anyone committed in, including the undecided", () => {
    for (const rsvp of ["going", "maybe", "waitlisted"] as const) {
      expect(mayReadBoard({ rsvp, favourited: false })).toBeNull()
    }
  })

  it("keeps out somebody who declined and never favourited", () => {
    expect(mayReadBoard({ rsvp: "not_going", favourited: false })).toBe("not_going")
    expect(mayReadBoard({ rsvp: null, favourited: false })).toBe("not_going")
  })
})

describe("posting to it", () => {
  it("takes going, not merely committed", () => {
    /*
     * `maybe` reads and does not post. Offering a seat in a car you may not be
     * driving to is worse than not offering.
     */
    expect(mayPostToBoard(going, complete, quiet)).toBeNull()
    expect(mayPostToBoard({ rsvp: "maybe", favourited: false }, complete, quiet)).toBe("not_going")
    expect(mayPostToBoard({ rsvp: null, favourited: true }, complete, quiet)).toBe("not_going")
  })

  it("takes a profile somebody can judge", () => {
    const cases: [string, BoardProfile][] = [
      ["no name", { ...complete, name: null }],
      ["blank name", { ...complete, name: "   " }],
      ["no age", { ...complete, age: null }],
      ["one interest", { ...complete, interestCount: MIN_INTERESTS_TO_RANK - 1 }],
      ["no intent", { ...complete, intentCount: 0 }],
    ]
    for (const [, p] of cases) {
      expect(mayPostToBoard(going, p, quiet)).toBe("profile_incomplete")
    }
  })

  it("does not ask for a photo", () => {
    /*
     * The board is pseudonymous, so a photo would be collected and never shown
     * — the definition of a field that should not be asked for. `BoardProfile`
     * has no photo field at all, which is the strongest form of that decision:
     * a caller cannot pass one by accident.
     */
    expect(profileIsComplete(complete)).toBe(true)
    expect(Object.keys(complete)).not.toContain("photo")
  })

  it("stops a spray at the outstanding cap", () => {
    expect(
      mayPostToBoard(going, complete, {
        outstandingRequests: BOARD.MAX_OUTSTANDING_REQUESTS,
        requestsThisWeek: 0,
      })
    ).toBe("too_many_outstanding")

    // And clears as people answer, so patience is never the thing blocking them.
    expect(
      mayPostToBoard(going, complete, {
        outstandingRequests: BOARD.MAX_OUTSTANDING_REQUESTS - 1,
        requestsThisWeek: 0,
      })
    ).toBeNull()
  })

  it("stops persistence at the weekly cap", () => {
    /*
     * The outstanding cap alone is defeatable by withdrawing and re-sending.
     * This bounds the total regardless of how fast they are answered — which
     * is why the two numbers are different and both exist.
     */
    expect(
      mayPostToBoard(going, complete, {
        outstandingRequests: 0,
        requestsThisWeek: BOARD.MAX_REQUESTS_PER_WEEK,
      })
    ).toBe("weekly_limit")
  })

  it("reports the first fix, not the last", () => {
    /*
     * Somebody who has not RSVP'd and has an empty profile is told to RSVP.
     * Naming the profile would send them to the wrong screen, and they would
     * fix it and still be refused.
     */
    const nobody: BoardProfile = { name: null, age: null, interestCount: 0, intentCount: 0 }
    expect(mayPostToBoard({ rsvp: null, favourited: false }, nobody, quiet)).toBe("not_going")
  })
})

describe("what a person is told", () => {
  it("says something different for every refusal", () => {
    // A shared "you cannot do that" names none of the four fixes.
    const messages = (
      ["not_going", "profile_incomplete", "too_many_outstanding", "weekly_limit"] as const
    ).map(boardDenialMessage)

    expect(new Set(messages).size).toBe(4)
    for (const m of messages) expect(m.length).toBeGreaterThan(20)
  })
})
