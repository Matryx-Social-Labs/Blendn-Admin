import type { connection_intent } from "@prisma/client"

/**
 * Who to show someone in the room, and why.
 *
 * Pure — no database, no clock beyond what is passed in. Everything hard here is
 * judgment about ranking people, which is the kind of thing that should be
 * cheap to argue with in a test rather than discovered in production.
 * `lib/geofence.ts` and `lib/presence.ts` are shaped the same way and are the
 * two modules in this repo with no production defects.
 *
 * ## The card names overlaps, not people
 *
 * > **Cosmic Panda** — you both picked Techno and Board games. Both here to
 * > network.
 *
 * That is what makes anonymity nearly free. A match list that had to show faces
 * would be the one screen undoing the pseudonymity every other surface keeps;
 * a list that names *what you have in common* loses almost nothing by withholding
 * who. Identity is exchanged on a mutual like, and then only if both revealed.
 *
 * ## No score is ever shown
 *
 * The number below orders the list and never leaves this file. A percentage
 * implies a precision this data cannot support and invites people to game it;
 * "you both picked Techno" explains itself and is checkable by the person
 * reading it.
 */

export type Intent = connection_intent

/** Intents that describe wanting to meet someone. `just_here` is not one. */
const SOCIAL_INTENTS: readonly Intent[] = ["dating", "networking", "friendship"]

/**
 * Weight for each intent both people share.
 *
 * Deliberately smaller than a rare shared interest is worth. Two people both
 * ticking "networking" at a networking event says very little — almost everyone
 * did — whereas both picking a niche category is a real signal.
 */
export const INTENT_BONUS = 0.6

/** Still in the room beats someone who has gone home. */
export const PRESENCE_BONUS = 1.5

/**
 * Someone who came only for the event ranks lower — but is never removed.
 *
 * A hard filter here would be the partition the one-pool decision exists to
 * avoid. People also change their minds during an evening, and "just here"
 * chosen at the door is not a refusal to ever be spoken to.
 */
export const JUST_HERE_DAMPING = 0.45

export interface MatchCandidate {
  userId: string
  /** Their pseudonym in this event's room. */
  pseudonym: string
  /** Structured category ids — `user_interests`, not the free-text field. */
  interestIds: string[]
  intents: Intent[]
  /** Currently checked in, as opposed to having attended earlier. */
  insideNow: boolean
  checkedInAt: Date
  /** Chose to be named at this event. */
  revealed: boolean
  name: string | null
  photo: string | null
}

export interface MatchViewer {
  userId: string
  interestIds: string[]
  intents: Intent[]
}

export interface Match {
  userId: string
  /** Pseudonym unless they revealed. Never the real name otherwise. */
  displayName: string
  /** Null unless they revealed. A photo identifies as surely as a name. */
  photo: string | null
  /** The actual overlapping category ids — this is what the card renders. */
  sharedInterestIds: string[]
  sharedIntents: Intent[]
  insideNow: boolean
}

/**
 * How much a shared interest is worth, by how rare it is.
 *
 * Inverse document frequency. Everyone at a music event likes "Music", so
 * sharing it says nothing; two people who both picked "Modular synths" have
 * found each other. Without this the ranking collapses into "who ticked the
 * most boxes", which rewards indiscriminate tagging and buries the real signal.
 *
 * `+1` in the denominator keeps a category nobody else picked from dividing by
 * zero, and the `max(…, 0)` floor stops a category *everyone* picked from
 * scoring negative.
 */
export function interestWeight(
  categoryId: string,
  holders: ReadonlyMap<string, number>,
  population: number
): number {
  if (population <= 0) return 0
  return Math.max(Math.log(population / (1 + (holders.get(categoryId) ?? 0))), 0)
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b)
  return a.filter((x) => set.has(x))
}

/** Their intents, or the profile default when they did not choose for this event. */
export function effectiveIntents(perEvent: Intent[], profileDefault: Intent[]): Intent[] {
  return perEvent.length > 0 ? perEvent : profileDefault
}

export function rankMatches(
  viewer: MatchViewer,
  candidates: MatchCandidate[],
  opts: {
    /** How many people in this room hold each category. */
    interestHolders: ReadonlyMap<string, number>
    /** People in the room — the denominator for rarity. */
    population: number
    limit?: number
  }
): Match[] {
  const scored = candidates
    .filter((c) => c.userId !== viewer.userId)
    .map((candidate) => {
      const sharedInterestIds = intersect(viewer.interestIds, candidate.interestIds)
      const sharedIntents = intersect(
        viewer.intents.filter((i) => SOCIAL_INTENTS.includes(i)),
        candidate.intents
      ) as Intent[]

      let score = sharedInterestIds.reduce(
        (sum, id) => sum + interestWeight(id, opts.interestHolders, opts.population),
        0
      )
      score += INTENT_BONUS * sharedIntents.length
      if (candidate.insideNow) score += PRESENCE_BONUS

      /*
       * Only when `just_here` is *all* they said — someone who picked it
       * alongside "networking" is networking.
       *
       * `.every()` on an empty array is true, and that is deliberate: silence
       * and "just here" are damped identically. The guard used to require
       * `length > 0`, which meant answering the question honestly ranked you
       * strictly below refusing to answer it — an empty intent array escaped
       * the damping that an explicit `just_here` received, with an otherwise
       * identical score. Punishing the honest answer is the wrong incentive in
       * a product whose whole premise is knowing what someone is open to.
       */
      const onlyJustHere = candidate.intents.every((i) => i === "just_here")
      if (onlyJustHere) score *= JUST_HERE_DAMPING

      return { candidate, sharedInterestIds, sharedIntents, score }
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        // Most recent arrival first: they are the people someone has not met yet.
        b.candidate.checkedInAt.getTime() - a.candidate.checkedInAt.getTime() ||
        // Stable across identical rows, so paging cannot drop or repeat anyone.
        a.candidate.userId.localeCompare(b.candidate.userId)
    )

  return scored.slice(0, opts.limit ?? scored.length).map(({ candidate, sharedInterestIds, sharedIntents }) => ({
    userId: candidate.userId,
    // The reveal decision is enforced here rather than at the route, so no
    // caller can forget it and no second implementation can disagree.
    displayName: candidate.revealed && candidate.name ? candidate.name : candidate.pseudonym,
    photo: candidate.revealed ? candidate.photo : null,
    sharedInterestIds,
    sharedIntents,
    insideNow: candidate.insideNow,
  }))
}
