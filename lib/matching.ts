import type { connection_intent } from "@prisma/client"

import { matchCompatibleForDating, type DatingProfile } from "@/lib/dating"
import { MIN_ROOM_FOR_WORK_FIELD } from "@/lib/work-fields"

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

/**
 * Weight for both people working in the same coarse field.
 *
 * Below `INTENT_BONUS`, and that ordering is the point: at a fintech meetup
 * everyone shares "Finance & Banking", so it says even less than two people
 * both ticking "networking" at a networking event. It is a tiebreak between
 * otherwise similar cards, not a reason to reorder the list.
 */
export const WORK_FIELD_BONUS = 0.3

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

/** Callers without a taxonomy get flat behaviour, not a crash. */
const EMPTY_PARENTS: ReadonlyMap<string, string> = new Map()

/**
 * How many overlaps a card names.
 *
 * Two, because the card is a reason to walk over, not a profile. Which two is
 * decided by weight — see `orderLabels`.
 */
export const MAX_SHARED_LABELS = 2

/**
 * The overlaps worth printing, most distinguishing first.
 *
 * **Never returns empty when an overlap exists**, and that is the whole point.
 * The obvious rule — drop anything scoring zero, so the card and the score
 * agree — is wrong at the boundary: `population` is the *candidate* count, so
 * a two-person room gives `log(2/2) = 0` for every shared interest however
 * rare. A card that named nothing at a brand-new event would be arithmetic
 * deciding that two people have nothing in common.
 *
 * Sorting by weight gets the property that rule was reaching for anyway. In a
 * music-event room "Techno" outranks "Music", so the distinguishing overlap
 * leads and the universal one only appears when it is genuinely all they share.
 */
function orderLabels(
  sharedIds: readonly string[],
  holders: ReadonlyMap<string, number>,
  population: number
): string[] {
  if (sharedIds.length <= 1) return [...sharedIds]
  return [...sharedIds]
    .map((id) => ({ id, w: interestWeight(id, holders, population) }))
    // Ties keep their original order, which is the viewer's own interest order.
    .sort((a, b) => b.w - a.w)
    .slice(0, MAX_SHARED_LABELS)
    .map((x) => x.id)
}

export interface MatchCandidate {
  userId: string
  /** Their pseudonym in this event's room. */
  pseudonym: string
  /** Structured category ids — `user_interests`, not the free-text field. */
  interestIds: string[]
  intents: Intent[]
  /** Coarse field-of-work slug, or null. Never an employer or a job title. */
  workField: string | null
  /**
   * Dating inputs. Read here and emitted nowhere — a `Match` carries neither,
   * and no card has ever stated anyone's gender.
   */
  dating: DatingProfile
  /**
   * Whole years, already derived. Never a birth date.
   *
   * Optional on the way in because a profile may carry neither a birth date nor
   * a stored age, and required on the way out as `number | null` — so every
   * caller handles "not known" explicitly rather than by forgetting the field.
   */
  age?: number | null
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
  workField: string | null
  dating: DatingProfile
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
  /**
   * Their field of work, or null in a room too small to say it.
   *
   * Shown whether or not the viewer shares it — "works in design" is a reason
   * to walk over even if you do not. The *bonus* needs both sides; the card
   * only needs theirs.
   */
  workField: string | null
  /**
   * Whether they work in the **viewer's** field.
   *
   * The ranking has always computed this — `WORK_FIELD_BONUS` below — and never
   * returned it, so the card's "You both work in Design" line had no server
   * field behind it and could not fire.
   *
   * ## Suppressed by the same floor as `workField`, and it must be
   *
   * This is not a convenience copy of the line above; it is a *stronger*
   * statement. The viewer knows their own field, so `true` names the
   * candidate's field exactly. Returning it in a small room while `workField`
   * is null would hand back the attribute the floor exists to withhold, through
   * a second door — the same shape as the `?workField=` filter the client-side
   * filtering exists to avoid.
   *
   * `false` is weaker but not free either: it eliminates one field of nineteen
   * for every card, and in a room of eight that is a real cut. So the honest
   * answer below the floor is `false` for everyone — the same thing a viewer
   * with no field of their own gets, which is what makes it uninformative.
   */
  sharedWorkField: boolean
  /**
   * Whole years.
   *
   * Unlike `workField` this is **not** suppressed in a small room. It is
   * already public — `publicProfileFields` returns it to any authenticated
   * caller — so withholding it here would only make the card disagree with the
   * profile one tap away, without withholding anything.
   */
  age: number | null
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

/**
 * Two people sharing "Techno" also share "Music". Score it once.
 *
 * The taxonomy is two levels — 13 parents, 67 leaves — and membership expands
 * upward in `lib/matches.ts` so that holding a leaf makes you a holder of its
 * parent. That expansion is what gives parents a *low* IDF weight: lots of
 * people hold "Music", so `log(population / (1 + holders))` is small for it.
 *
 * But it also means the intersection of two expanded sets contains both the
 * leaf and its parent whenever a leaf is shared. Scoring both would count one
 * affinity twice, and the inflation is worst between the most similar people —
 * exactly where the ranking needs its resolution.
 *
 * So: keep the most specific node per branch. Sharing Techno *implies* sharing
 * Music, so the parent carries no information the leaf did not already carry.
 *
 *     shared {techno, music}          → {techno}      parent implied
 *     shared {techno, classical, music} → {techno, classical}
 *                                                     siblings both count
 *     shared {music}                  → {music}       nobody shares a leaf
 *     shared {techno, sports}         → {techno, sports}
 *
 * **There is no walk, which is the point.** `categories.parent_id` is a plain
 * self-relation: a third level is insertable, and so is a cycle (A parents B,
 * B parents A). A `while (parentOf.has(id))` ascent would hang the request
 * thread on data nobody can see is wrong.
 *
 * Each id checks its own immediate parent, once. That cannot loop by
 * construction, and it happens to collapse a deeper chain correctly anyway —
 * given `sub → techno → music`, `sub` suppresses `techno`, `techno` suppresses
 * `music`, and only the most specific node survives. Termination is structural
 * rather than a depth cap someone has to remember to keep.
 */
export function collapseToMostSpecific(
  sharedIds: readonly string[],
  parentOf: ReadonlyMap<string, string>
): string[] {
  if (sharedIds.length < 2) return [...sharedIds]

  const shared = new Set(sharedIds)
  // A parent is redundant only when one of ITS OWN children is also shared —
  // not merely because some other leaf happens to be shared.
  const impliedParents = new Set<string>()
  for (const id of sharedIds) {
    const parent = parentOf.get(id)
    if (parent && shared.has(parent)) impliedParents.add(parent)
  }

  return sharedIds.filter((id) => !impliedParents.has(id))
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
    /**
     * Child category id → its parent. Built in `lib/matches.ts` alongside
     * `interestHolders`, for the same reason: the ranking rule stays pure and
     * testable with a literal map, and the database stays on the other side of
     * the seam.
     */
    parentOf?: ReadonlyMap<string, string>
    /** People in the room — the denominator for rarity. */
    population: number
    limit?: number
  }
): Match[] {
  const scored = candidates
    .filter((c) => c.userId !== viewer.userId)
    .map((candidate) => {
      const sharedInterestIds = collapseToMostSpecific(
        intersect(viewer.interestIds, candidate.interestIds),
        opts.parentOf ?? EMPTY_PARENTS
      )
      /*
       * `dating` survives only if the two are plausibly a match.
       *
       * A tag filter, not a pool filter: nobody is removed from the list, and
       * two men who both ticked dating still match on interests and on
       * networking. What changes is that the card stops telling them they are a
       * dating match, which it used to do for everyone — `matches.ts` never
       * read gender at all.
       *
       * Removing the tag rather than the person is what keeps the one-pool
       * decision intact (`JUST_HERE_DAMPING` above has the same shape), and it
       * means "Both open to dating" has *already* had compatibility checked —
       * so the card can be accurate without ever stating anyone's gender.
       *
       * Undeclared fails closed: no gender, no `interested_in`, no tag.
       */
      const sharedIntents = (
        intersect(
          viewer.intents.filter((i) => SOCIAL_INTENTS.includes(i)),
          candidate.intents
        ) as Intent[]
      ).filter(
        (i) => i !== "dating" || matchCompatibleForDating(viewer.dating, candidate.dating)
      )

      let score = sharedInterestIds.reduce(
        (sum, id) => sum + interestWeight(id, opts.interestHolders, opts.population),
        0
      )
      score += INTENT_BONUS * sharedIntents.length
      if (viewer.workField && candidate.workField === viewer.workField) {
        score += WORK_FIELD_BONUS
      }
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

      /*
       * Scored on every overlap, labelled with the best two. The score uses the
       * full collapsed set — truncating it would make the ranking depend on how
       * much fits on a card.
       */
      const labelIds = orderLabels(sharedInterestIds, opts.interestHolders, opts.population)

      return { candidate, sharedInterestIds: labelIds, sharedIntents, score }
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        // Most recent arrival first: they are the people someone has not met yet.
        b.candidate.checkedInAt.getTime() - a.candidate.checkedInAt.getTime() ||
        // Stable across identical rows, so paging cannot drop or repeat anyone.
        a.candidate.userId.localeCompare(b.candidate.userId)
    )

  /*
   * The small-room floor.
   *
   * The roster already gives an unrevealed person an age and a city. Field of
   * work makes four attributes with the interests, and "29, Bengaluru, works in
   * fintech, into techno and board games" is one specific person in a room of
   * eight — at which point the pseudonym is doing nothing.
   *
   * `population` is the room, not the page, so paging cannot shrink it into
   * suppression. It counts everyone but the viewer, which is the right set:
   * the anonymity set is the people a card *could* be, and the reader is not
   * one of them. Same number and reasoning as the organiser metrics floor; a
   * test asserts the two constants are equal.
   */
  const roomIsBigEnough = opts.population >= MIN_ROOM_FOR_WORK_FIELD

  return scored.slice(0, opts.limit ?? scored.length).map(({ candidate, sharedInterestIds, sharedIntents }) => ({
    userId: candidate.userId,
    // The reveal decision is enforced here rather than at the route, so no
    // caller can forget it and no second implementation can disagree.
    displayName: candidate.revealed && candidate.name ? candidate.name : candidate.pseudonym,
    photo: candidate.revealed ? candidate.photo : null,
    sharedInterestIds,
    sharedIntents,
    // Suppressed, not scrubbed from the ranking: it still moved the order
    // above, because the *score* is never shown and the attribute is.
    workField: roomIsBigEnough ? candidate.workField : null,
    /*
     * Same floor, and see the field's own note for why that is not caution.
     * The viewer knows their own field, so `true` names the candidate's — this
     * would be a second door onto the attribute the line above just closed.
     */
    sharedWorkField:
      roomIsBigEnough && !!viewer.workField && candidate.workField === viewer.workField,
    age: candidate.age ?? null,
    insideNow: candidate.insideNow,
  }))
}
