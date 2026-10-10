// Relative imports throughout — see lib/conversations.ts.
import { IPL_PARENT_SLUG } from "../about-you"
import { db } from "../db"
import { INTENT_BONUS } from "../matching"
import {
  crewHeld,
  crewOverlaps,
  NO_TRAITS,
  personKeys,
  sizeBalance,
  type Badge,
  type DisplayTraits,
  type MemberTraits,
  type Overlap,
} from "../overlaps"

/**
 * What crews hold, how a viewer's side ranks them, and what their cards may
 * say (plan v2 §8.3 crew ↔ crew and crew ↔ person, §8.6 crew badges).
 *
 * ## Counts-only, still
 *
 * A crew card never carries a member (step 8, C4). Everything here is a
 * **crew-held** trait — held by at least two members and a third of the crew
 * (`crewHoldsAt`) — or a fact about the crew as a whole. No line ever says
 * which member, or how many: "Both crews are into techno", never "3 of 4".
 * Languages and home states, the origin-like Tier B, only between crews of
 * four or more here in a room of eight or more (§8.3), one line at most.
 *
 * ## Ranked on what was chosen, balanced on size
 *
 * Crew-held interests (rarity across the crews here, like a person's) and
 * shared crew intent. A this-or-that majority, a language, a home state are
 * printed and never scored. Then the size balance: a crew more than twice the
 * other's size is damped (Timeleft balances its tables) — a crew of two facing
 * twelve is a mismatch however much they share.
 */

const SOCIAL = new Set(["dating", "networking", "friendship"])

/** Room size below which origin-like crew lines are not printed (the work-field floor). */
const MIN_ROOM_FOR_TIER_B = 8
/** Crews this small never print origin-like lines: a crew of two "has Kerala folks" names both. */
const MIN_CREW_FOR_TIER_B = 4
/** "N nights out together" from this many. */
export const CREW_NIGHTS_BADGE_MIN = 2

interface CrewIn {
  id: string
  intent: readonly string[]
}

/** Interests (expanded to their parents) and display traits for these people. */
async function membersTraits(userIds: readonly string[]): Promise<{
  of: (id: string) => MemberTraits
  parentOf: Map<string, string>
  categoryName: Map<string, string>
  iplTeams: Map<string, string>
}> {
  const ids = [...new Set(userIds)]
  const [categories, interests, profiles, answers] = await Promise.all([
    db.categories.findMany({ select: { id: true, name: true, parent_id: true, parent: { select: { slug: true } } } }),
    ids.length ? db.user_interests.findMany({ where: { user_id: { in: ids } }, select: { user_id: true, category_id: true } }) : [],
    ids.length
      ? db.profiles.findMany({
          where: { id: { in: ids } },
          select: { id: true, languages: true, home_state: true },
        })
      : [],
    ids.length
      ? db.this_or_that_answers.findMany({ where: { user_id: { in: ids } }, select: { user_id: true, question: true, choice: true } })
      : [],
  ])
  const parentOf = new Map(categories.flatMap((c) => (c.parent_id ? [[c.id, c.parent_id] as [string, string]] : [])))
  const categoryName = new Map(categories.map((c) => [c.id, c.name]))
  const iplTeams = new Map(categories.flatMap((c) => (c.parent?.slug === IPL_PARENT_SLUG ? [[c.id, c.name] as [string, string]] : [])))

  const interestsOf = new Map<string, Set<string>>()
  for (const i of interests) {
    const set = interestsOf.get(i.user_id) ?? new Set<string>()
    set.add(i.category_id)
    const parent = parentOf.get(i.category_id)
    if (parent) set.add(parent)
    interestsOf.set(i.user_id, set)
  }
  const answersOf = new Map<string, Record<string, string>>()
  for (const a of answers) answersOf.set(a.user_id, { ...answersOf.get(a.user_id), [a.question]: a.choice })
  const profileOf = new Map(profiles.map((p) => [p.id, p]))

  const of = (id: string): MemberTraits => {
    const p = profileOf.get(id)
    // Signs are not crew signals: no line here reads them.
    const traits: DisplayTraits = p
      ? { answers: answersOf.get(id) ?? {}, languages: p.languages, homeState: p.home_state, sign: null }
      : { ...NO_TRAITS, answers: answersOf.get(id) ?? {} }
    return { interestIds: [...(interestsOf.get(id) ?? [])], traits }
  }
  return { of, parentOf, categoryName, iplTeams }
}

/**
 * Nights each crew has been out together: occurrences where two or more of
 * its members checked in, counting only check-ins after each member joined —
 * a crew's history starts when it does.
 */
export async function nightsTogether(crewIds: readonly string[]): Promise<Map<string, number>> {
  if (crewIds.length === 0) return new Map()
  const rows = await db.$queryRaw<{ crew_id: string; nights: bigint }[]>`
    SELECT t.crew_id, COUNT(*) AS nights
      FROM (
        SELECT m.crew_id, ci.occurrence_id
          FROM crew_members m
          JOIN event_check_ins ci ON ci.user_id = m.user_id
         WHERE m.crew_id = ANY(${[...crewIds]}::uuid[])
           AND ci.kind = 'attendee'
           AND ci.check_in_time IS NOT NULL
           AND ci.check_in_time >= m.joined_at
      GROUP BY m.crew_id, ci.occurrence_id
        HAVING COUNT(DISTINCT m.user_id) >= 2
      ) t
  GROUP BY t.crew_id
  `
  return new Map(rows.map((r) => [r.crew_id, Number(r.nights)]))
}

export function crewBadges(nights: number): Badge[] {
  return nights >= CREW_NIGHTS_BADGE_MIN ? [{ kind: "nights_together", label: `${nights} nights out together` }] : []
}

export interface RankedCrew {
  id: string
  score: number
  overlaps: Overlap[]
}

/**
 * Score and lines for every crew here, from the viewer's side: their crew
 * here (the one with most members present), or themselves alone.
 *
 * Rarity is across the crews here (and the viewer's side), so "Both crews are
 * into techno" at a techno night weighs little, and a crew-held CSK in RCB
 * country weighs a lot.
 */
export async function rankCrewsFor(input: {
  viewerId: string
  /** The viewer's crew here, or null when they are here alone. */
  mine: (CrewIn & { present: readonly string[] }) | null
  /** The viewer's intents here, for a solo viewer. */
  viewerIntents: readonly string[]
  crews: readonly (CrewIn & { present: readonly string[] })[]
  /** People checked in at the occurrence: the room the Tier B floor reads. */
  roomSize: number
}): Promise<Map<string, RankedCrew>> {
  const { mine, crews } = input
  const people = [input.viewerId, ...(mine?.present ?? []), ...crews.flatMap((c) => c.present)]
  const t = await membersTraits(people)

  const heldOf = new Map(crews.map((c) => [c.id, crewHeld(c.present.map(t.of))]))
  const mySide = mine ? crewHeld(mine.present.map(t.of)) : personKeys(t.of(input.viewerId))

  // How many sides here hold each key: rarity across the crews.
  const holders = new Map<string, number>()
  for (const set of [mySide, ...heldOf.values()]) for (const k of set) holders.set(k, (holders.get(k) ?? 0) + 1)
  const population = heldOf.size + 1

  const myIntents = (mine ? mine.intent : input.viewerIntents).filter((i) => SOCIAL.has(i))
  const ranked = new Map<string, RankedCrew>()
  for (const c of crews) {
    const tierBAllowed =
      input.roomSize >= MIN_ROOM_FOR_TIER_B &&
      c.present.length >= MIN_CREW_FOR_TIER_B &&
      (!mine || mine.present.length >= MIN_CREW_FOR_TIER_B)
    const { overlaps, interestScore } = crewOverlaps(mySide, heldOf.get(c.id)!, !mine, {
      holders,
      population,
      parentOf: t.parentOf,
      categoryName: t.categoryName,
      iplTeams: t.iplTeams,
      tierBAllowed,
    })
    const sharedIntents = myIntents.filter((i) => c.intent.includes(i)).length
    const score =
      (interestScore + INTENT_BONUS * sharedIntents) * sizeBalance(mine ? mine.present.length : null, c.present.length)
    ranked.set(c.id, { id: c.id, score, overlaps })
  }
  return ranked
}
