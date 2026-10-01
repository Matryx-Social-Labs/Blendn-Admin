import { z } from "zod"

import { BOARD } from "./constants"
import { MIN_INTERESTS_TO_RANK } from "./interest-coverage"

/**
 * Who may read the board, who may post to it, and who may ask somebody.
 *
 * Pure, so the rules can be tested without a database or a clock — the same
 * split `lib/chat-window.ts` uses for the room, and for the same reason: the
 * interesting cases are cheap to state and expensive to set up.
 *
 * ## Why the two gates differ
 *
 * Reading is cheap and posting is not, and the asymmetry is deliberate. A
 * favourite is one tap and costs nothing; the ask here — *be alone with me,
 * travel with me, share a car* — is materially riskier than a message in a
 * crowded room, and it is the one place on this product where two people
 * arrange to meet away from a venue full of witnesses.
 *
 * So browsing takes a tap, and asking takes a commitment, a complete profile
 * and a cap.
 */

export type BoardReadDenial = "not_going"

export type BoardWriteDenial =
  | "not_going"
  | "profile_incomplete"
  | "too_many_outstanding"
  | "weekly_limit"

/** What the viewer has done about this event. */
export interface BoardEntitlement {
  /** `going`, `maybe` and `waitlisted` all count as committed. */
  rsvp: "going" | "maybe" | "waitlisted" | "not_going" | null
  favourited: boolean
}

/**
 * The fields that make a profile answerable, and nothing else.
 *
 * `profiles.onboarded` is deliberately not consulted. It is a client-set
 * boolean no API has ever enforced — an account one millisecond old can set it
 * — and it is counted as a business metric on the admin funnel, which makes it
 * the last thing that should gate anything.
 */
export interface BoardProfile {
  name: string | null
  /** Whole years, already derived. A birth date is not this function's problem. */
  age: number | null
  /** Structured category ids, not the free-text column. */
  interestCount: number
  intentCount: number
}

/**
 * May they see the board at all?
 *
 * A favourite is enough. Somebody deciding whether to go is exactly who the
 * board is for — "is anyone else going alone" is a reason to commit, and
 * requiring the commitment first inverts it.
 */
export function mayReadBoard(e: BoardEntitlement): BoardReadDenial | null {
  if (e.favourited) return null
  if (e.rsvp && e.rsvp !== "not_going") return null
  return "not_going"
}

/**
 * Is this profile complete enough to ask a stranger to meet them?
 *
 * Name, age, two structured interests, one intent. **No photo** — the board is
 * pseudonymous, so a photo would be collected and never shown, which is the
 * definition of a field that should not be asked for.
 *
 * Two interests rather than one because `MIN_INTERESTS_TO_RANK` is already the
 * threshold for being rankable at all; a person the matcher cannot place is not
 * somebody the board can describe either. Reusing it means one definition of
 * "we know enough about you", not two that drift.
 */
export function profileIsComplete(p: BoardProfile): boolean {
  if (!p.name || p.name.trim().length === 0) return false
  if (p.age === null) return false
  if (p.interestCount < MIN_INTERESTS_TO_RANK) return false
  if (p.intentCount < 1) return false
  return true
}

/** What the caps need to know. Counted by the caller, judged here. */
export interface BoardActivity {
  outstandingRequests: number
  requestsThisWeek: number
}

/**
 * May they post, or send a request?
 *
 * Committed, complete, and under both caps. The order of the checks is the
 * order of the fixes: telling somebody their profile is incomplete when the
 * real problem is that they have not RSVP'd would send them to the wrong
 * screen.
 */
export function mayPostToBoard(
  e: BoardEntitlement,
  profile: BoardProfile,
  activity: BoardActivity
): BoardWriteDenial | null {
  /*
   * `going`, not merely committed. `maybe` and `waitlisted` are enough to read
   * — they are people still deciding — but posting an offer of a seat in a car
   * you may not be driving to is worse than not posting.
   */
  if (e.rsvp !== "going") return "not_going"
  if (!profileIsComplete(profile)) return "profile_incomplete"
  if (activity.outstandingRequests >= BOARD.MAX_OUTSTANDING_REQUESTS) return "too_many_outstanding"
  if (activity.requestsThisWeek >= BOARD.MAX_REQUESTS_PER_WEEK) return "weekly_limit"
  return null
}

/**
 * The board closes at doors — for reading as well as writing. After that the
 * room is the place, gated on presence rather than intent.
 */
export const BOARD_CLOSED = "The board closes when the doors open — the room is open instead"

/**
 * Every refused re-ask reads this, whatever the row underneath says.
 *
 * A decline is never delivered to the asker. "They have already answered this
 * one" was a delivery: the only answer a person can be refused a second ask
 * after is a no. So a pending ask, a declined one and a withdrawn one all
 * answer with the same sentence.
 */
export const ALREADY_ASKED = "You have already asked — give them a moment"

/**
 * The sentence a person reads. One per denial, because each has a different
 * fix and a shared "you cannot do that" names none of them.
 */
export function boardDenialMessage(d: BoardReadDenial | BoardWriteDenial): string {
  switch (d) {
    case "not_going":
      return "Mark yourself as going to post here"
    case "profile_incomplete":
      return "Add your name, age, two interests and why you go out — people are deciding whether to travel with you"
    case "too_many_outstanding":
      return `You have ${BOARD.MAX_OUTSTANDING_REQUESTS} asks waiting for an answer. Give them a moment.`
    case "weekly_limit":
      return "You have sent a lot of requests this week. Try again in a few days."
  }
}

/**
 * A report about a board post or a board ask (SCRUM-322).
 *
 * The reasons are the app's message-report reasons: a post and an ask are
 * both words somebody wrote, and one list means the client's sheet and the
 * admin queue's reason filter do not grow a second vocabulary.
 */
export const boardReportSchema = z.object({
  reason: z.enum(["harassment", "hate_speech", "inappropriate_content", "spam", "other"]),
  description: z.string().trim().max(500).optional(),
})
