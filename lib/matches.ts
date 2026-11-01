import { ConversationClosedError, closedPairKeys, openConversation } from "@/lib/conversations"
import { lockPair, pairIsLinked, releaseHeldRequests } from "@/lib/friends"
import { notStrangersTo } from "@/lib/room-people"
import { exposuresFor, recordImpressions } from "./exposure"
import { db } from "@/lib/db"
import { inRoomWhere } from "@/lib/event-kind"
import { notifyMatch } from "@/lib/push-notifications"
import { emitPrivateRevealed } from "@/lib/private-revealed"
import {
  effectiveIntents,
  rankMatches,
  type Intent,
  type MatchCandidate,
} from "@/lib/matching"
import type { Gender } from "@/lib/dating"
import { ageFrom } from "@/lib/age"
import { MIN_ROOM_FOR_WORK_FIELD, workFieldLabel } from "@/lib/work-fields"
import { roomHandle } from "@/lib/room-handle"
import { notHostBannedFrom } from "@/lib/room-kind"
import { visibleInRoom } from "@/lib/identity"
import { IPL_PARENT_SLUG } from "@/lib/about-you"
import {
  badgesFor,
  NIGHTS_OUT_DAYS,
  NO_TRAITS,
  personCard,
  REGULAR_HERE_DAYS,
  roomTeam,
  SHOWS_UP_DAYS,
  traitHolders,
  viewerTierB,
  type Badge,
  type DisplayTraits,
  type Overlap,
} from "@/lib/overlaps"

/**
 * Everything `rankMatches` needs, gathered from the database.
 *
 * Split the way `getOccupancy` is split from `occupancyFrom`: the queries live
 * here, the judgment lives in `lib/matching.ts` where it can be argued with in a
 * unit test.
 */

export interface MatchCard {
  userId: string
  displayName: string
  photo: string | null
  /** Names, not ids — the card renders "Techno", and a uuid explains nothing. */
  sharedInterests: string[]
  sharedIntents: Intent[]
  /**
   * "Design", not "design" and not "Principal Designer at Swiggy".
   *
   * The label, resolved here, because a card must never render a raw slug and
   * the client should not be holding its own copy of the mapping. Null in a
   * room below `MIN_ROOM_FOR_WORK_FIELD`, where four attributes name one
   * person, and null for anyone who has not said.
   */
  workField: string | null
  /**
   * Whether they work in *your* field.
   *
   * Already computed for the ranking (`WORK_FIELD_BONUS`) and never returned,
   * so the card's "You both work in Design" box had nothing behind it.
   *
   * Suppressed by the same floor as `workField`, and that is not caution: you
   * know your own field, so `true` names theirs exactly. See `lib/matching.ts`.
   */
  sharedWorkField: boolean
  /**
   * Whole years, derived. Never a birth date.
   *
   * Already public: `publicProfileFields` on `/profiles/[userId]` returns it to
   * any authenticated caller, outside the identity gate. The roster simply did
   * not carry it, so a card could not say what the profile one tap away said
   * anyway -- and on a roster where most people share no interests, one more
   * true fact is the difference between a card you can act on and a name.
   */
  age: number | null
  insideNow: boolean
  /** Whether *you* have liked them. Never whether they have liked you. */
  youLiked: boolean
  /**
   * Display-only lines both of you share, as sentences: an IPL team, a
   * this-or-that answer, and — budgeted, Tier B — a language, a home state or
   * a sign (`lib/overlaps.ts`). Never scored. Empty when nothing is shared.
   */
  overlaps: Overlap[]
  /** Their sign — "Leo ♌" — when they chose to show it and the card's Tier B budget allows. */
  sign: string | null
  /** Earned by check-ins ("Regular here", "Shows up", "5+ nights this month"). Empty in a small room. */
  badges: Badge[]
}

/** Interest-tree leaves that are IPL teams: category id → team code ("CSK"). */
export async function iplTeamIds(): Promise<Map<string, string>> {
  const rows = await db.categories.findMany({
    where: { parent: { slug: IPL_PARENT_SLUG } },
    select: { id: true, name: true },
  })
  return new Map(rows.map((r) => [r.id, r.name]))
}

/** The display traits of these people, by id — profile columns plus this-or-that answers. */
export interface TraitProfile {
  languages: string[]
  home_state: string | null
  sun_sign: string | null
  sign_system: string | null
  work_field: string | null
}

export async function displayTraitsOf(
  profiles: ReadonlyMap<string, TraitProfile | null | undefined>
): Promise<Map<string, DisplayTraits>> {
  const ids = [...profiles.keys()]
  const answers = ids.length
    ? await db.this_or_that_answers.findMany({
        where: { user_id: { in: ids } },
        select: { user_id: true, question: true, choice: true },
      })
    : []
  const answersOf = new Map<string, Record<string, string>>()
  for (const a of answers) answersOf.set(a.user_id, { ...answersOf.get(a.user_id), [a.question]: a.choice })
  return new Map(
    ids.map((id) => {
      const p = profiles.get(id)
      return [
        id,
        p
          ? {
              answers: answersOf.get(id) ?? {},
              languages: p.languages ?? [],
              homeState: p.home_state ?? null,
              sign: p.sun_sign && p.sign_system ? { slug: p.sun_sign, system: p.sign_system } : null,
              workField: p.work_field ?? null,
            }
          : { ...NO_TRAITS, answers: answersOf.get(id) ?? {} },
      ]
    })
  )
}

/** Display traits, as `displayTraitsOf` reads them from a profile. */
const traitColumns = { languages: true, home_state: true, sun_sign: true, sign_system: true, work_field: true } as const

/**
 * Child → parent, for the whole interest taxonomy. Two levels, ~80 rows.
 *
 * Exported so every "do these two share an interest" question in the Room —
 * the ranked deck here and the count on `room-preview` — expands the same way.
 * Two answers to that question would put "3 people here share your taste" over
 * a deck that shows none of them sharing anything.
 */
export async function interestParents(): Promise<Map<string, string>> {
  const parentOf = new Map<string, string>()
  for (const row of await db.categories.findMany({
    where: { parent_id: { not: null } },
    select: { id: true, parent_id: true },
  })) {
    parentOf.set(row.id, row.parent_id!)
  }
  return parentOf
}

/**
 * A held set, plus the parents those holdings imply. Deduplicated.
 *
 * Storage is leaf-only, so without this someone into "IPL screening" and
 * someone into "Running" intersect on nothing — the shared "Sports" is not in
 * either raw row. See the call site in `matchesForEvent` for the rarity half.
 */
export function expandInterests(
  ids: readonly string[],
  parentOf: ReadonlyMap<string, string>
): string[] {
  const held = new Set<string>()
  for (const id of ids) {
    held.add(id)
    const parent = parentOf.get(id)
    if (parent) held.add(parent)
  }
  return [...held]
}

/**
 * The room, ranked for one person in it.
 *
 * Returns `null` when the viewer has never checked in to this event — the match
 * list is a view of a room you were in, not a directory you can browse.
 */
export async function matchesForEvent(
  eventId: string,
  viewerId: string,
  limit = 50
): Promise<MatchCard[] | null> {
  const viewerCheckIn = await db.event_check_ins.findFirst({
    // Event-level rather than per-occurrence: attending any day of a run puts
    // you in the room with everyone else who came, on any day. Existence only —
    // what they *chose* now lives in `event_match_preferences`, because this
    // query returns an arbitrary one of their check-in rows.
    // At a venue day, only while live (`inRoomWhere`): the grid is reciprocal.
    where: { event_id: eventId, user_id: viewerId, check_in_time: { not: null }, ...inRoomWhere(viewerId) },
    // Their latest: whether their own Tier B predates it (`viewerTierB`, step 10 review H1), and whether they are at work.
    select: { id: true, check_in_time: true, kind: true },
    orderBy: { check_in_time: "desc" },
  })
  // Staff are working, not mingling: no deck of their own room either (SCRUM-891, owner row A-6). The latest row decides.
  if (!viewerCheckIn || viewerCheckIn.kind === "staff") return null

  const [viewerProfile, viewerInterests, checkIns, prefs, blocks, closedPairs, friends, likes, reported] =
    await Promise.all([
    db.profiles.findUnique({
      where: { id: viewerId },
      select: { intent_default: true, gender: true, interested_in: true, tier_b_changed_at: true, ...traitColumns },
    }),
    db.user_interests.findMany({ where: { user_id: viewerId }, select: { category_id: true } }),
    db.event_check_ins.findMany({
      where: {
        event_id: eventId,
        check_in_time: { not: null },
        // A venue day's grid is the people live there now.
        ...inRoomWhere(),
        // Staff are working, not mingling. They are excluded from attendance for
        // the same reason and it would be strange to offer the bar manager as a
        // match.
        kind: "attendee",
        // Nor a member a host banned from the room (M3, `notHostBannedFrom`).
        user: notHostBannedFrom({ event_id: eventId }),
      },
      select: {
        user_id: true,
        status: true,
        check_in_time: true,
        user: {
          select: {
            name: true,
            image: true,
            profile: {
              select: {
                intent_default: true,
                photos: true,
                // `work_field` comes with `traitColumns` below.
                // "Show online status" off: in the room, counted, not listed
                // (SCRUM-141). Read here and filtered below rather than in the
                // `where`, so a person with no profile row is not dropped by a
                // relation filter that reads NULL as false.
                show_online: true,
                /*
                 * For the derived age on the card.
                 *
                 * `date_of_birth` and `age` both, because `ageFrom` prefers the
                 * birth date and falls back to the stored number -- and neither
                 * is returned. Only the derived years reach a client, so the
                 * card can say "29" without anybody learning a birthday.
                 */
                date_of_birth: true,
                age: true,
                // Read to decide whether `dating` may appear as a shared
                // intent, and returned to nobody: `MatchCard` has no field for
                // either, and a card has never stated anyone's gender.
                gender: true,
                interested_in: true,
                // Display only (lib/overlaps.ts): printed when shared, never scored.
                ...traitColumns,
                shows_up_badge: true,
                show_badges: true,
              },
            },
            user_interests: { select: { category_id: true } },
          },
        },
      },
    }),
    // One row per person per event, fetched for the whole room in one query
    // rather than joined per check-in row — a person attending three days has
    // three check-ins and exactly one answer.
    db.event_match_preferences.findMany({
      where: { event_id: eventId },
      select: { user_id: true, intent: true },
    }),
    db.blocked_users.findMany({
      where: { OR: [{ blocker_id: viewerId }, { blocked_id: viewerId }] },
      select: { blocker_id: true, blocked_id: true },
    }),
    // Leaving is permanent: an unmatched pair never appears to each other
    // again. Same `hidden` set as blocks below -- one exclusion, two reasons.
    closedPairKeys(viewerId),
    // Friends are not strangers (the owner's rule, 2026-10-22): they leave the
    // deck whatever their switch (`notStrangersTo`).
    notStrangersTo(viewerId).then((set) => [...set]),
    db.event_likes.findMany({
      where: { event_id: eventId, liker_id: viewerId },
      select: { liked_id: true },
    }),
    // Whoever the viewer reported stays off their own deck and grid, for good
    // (SCRUM-229 ruling): a block on the reporter's side, without blocking.
    // `user_reports` has no event column, so it holds in every room.
    db.user_reports.findMany({
      where: { reporter_id: viewerId },
      select: { reported_id: true },
      distinct: ["reported_id"],
    }),
  ])

  /*
   * EVERY friend leaves the deck, whatever their switch (the owner's rule,
   * 2026-10-22: two friends never meet as strangers). This used to remove only
   * the friends you could recognise and keep the rest as pseudonymous cards, on
   * the argument that "on the roster, not in the deck" would name the one handle
   * that is your friend. That argument is gone with the roster: a friend leaves
   * the roster the same way (`notStrangersTo`), and a friend who allows it is in
   * "Friends here" instead, by real id. The deck now answers, for a friend, what
   * it answers for someone with "Show online status" off: absent.
   */
  const hidden = new Set([
    ...blocks.map((b) => (b.blocker_id === viewerId ? b.blocked_id : b.blocker_id)),
    ...closedPairs,
    ...friends,
    ...reported.map((r) => r.reported_id),
  ])
  const liked = new Set(likes.map((l) => l.liked_id))

  const prefsOf = new Map(prefs.map((p) => [p.user_id, p]))

  /*
   * One candidate per person, not one per day they came.
   *
   * `event_check_ins` is keyed per occurrence, so somebody who attended three
   * days of a conference has three rows here — and this used to map straight
   * over them, putting the same person on the match list three times. Keeping
   * the most recent row also makes `insideNow` mean "are they here now" rather
   * than "were they here on whichever day sorted first".
   */
  const latestPerUser = new Map<string, (typeof checkIns)[number]>()
  for (const c of checkIns) {
    if (c.user_id === viewerId || hidden.has(c.user_id)) continue
    if (c.user.profile?.show_online === false) continue
    const seen = latestPerUser.get(c.user_id)
    if (!seen || (c.check_in_time?.getTime() ?? 0) > (seen.check_in_time?.getTime() ?? 0)) {
      latestPerUser.set(c.user_id, c)
    }
  }
  const eligible = [...latestPerUser.values()]

  /*
   * Child → parent, for the whole taxonomy. Two levels, ~80 rows, one query.
   *
   * Fetched here and handed to `rankMatches` as an option, exactly like
   * `interestHolders` below: the database stays on this side of the seam and
   * the scoring rule stays pure, so `collapseToMostSpecific` is testable with a
   * literal map instead of a fixture.
   */
  const parentOf = await interestParents()

  /**
   * A held set, plus the parents those holdings imply. Deduplicated.
   *
   * Used for **both** the holder counts and the interest lists handed to
   * ranking, and it has to be both. Storage is leaf-only, so without expanding
   * the lists too, someone into "IPL screening" and someone into "Running"
   * would intersect on nothing — the shared "Sports" that this whole stage
   * exists to find is not in either raw row.
   */
  const expand = (ids: readonly string[]): string[] => expandInterests(ids, parentOf)

  /*
   * Rarity counts each person once per category.
   *
   * The per-user `Set` inside `expand` is the part that is easy to get wrong:
   * someone holding "Techno" *and* "Classical" must count **once** for "Music",
   * not twice. Counting twice inflates the holder count with a single person's
   * breadth and makes the parent look commoner than the room actually is.
   */
  const interestHolders = new Map<string, number>()
  for (const c of eligible) {
    for (const id of expand(c.user.user_interests.map((i) => i.category_id))) {
      interestHolders.set(id, (interestHolders.get(id) ?? 0) + 1)
    }
  }

  /*
   * Shared history, in ONE query for the whole room.
   *
   * Two hops over indexes that already exist — `@@index([user_id, status])` to
   * find the viewer's past events, `@@index([event_id, status])` to find who
   * else was at them — rather than a query per candidate, which on a
   * two-hundred-person room would be two hundred round trips on the deck's
   * first paint.
   *
   * Bounded to 90 days (R21). Beyond that it stops being "we keep ending up in
   * the same rooms" and becomes a lifetime tally, which ranks the room by who
   * has been out most.
   *
   * `kind = 'attendee'`: staff are at everything, so counting them would give
   * every regular attendee a strong bond with the door team.
   */
  const CO_ATTENDANCE_DAYS = 90
  const since = new Date(Date.now() - CO_ATTENDANCE_DAYS * 24 * 60 * 60 * 1000)
  const candidateIds = eligible.map((c) => c.user_id)

  const sharedRows =
    candidateIds.length > 0
      ? await db.$queryRaw<{ user_id: string; shared: bigint }[]>`
          SELECT user_id, COUNT(DISTINCT event_id) AS shared
            FROM event_check_ins
           WHERE user_id = ANY(${candidateIds})
             AND kind = 'attendee'
             AND event_id <> ${eventId}::uuid
             AND event_id IN (
               SELECT event_id FROM event_check_ins
                WHERE user_id = ${viewerId}
                  AND kind = 'attendee'
                  AND event_id <> ${eventId}::uuid
                  AND check_in_time >= ${since}
             )
        GROUP BY user_id
        `
      : []
  const sharedOf = new Map(sharedRows.map((r) => [r.user_id, Number(r.shared)]))

  /*
   * Where they are both going NEXT, in one more query.
   *
   * `event_favorites` and `event_rsvps` fed nothing until now — RSVP was a
   * dead-end signal that existed only as a dashboard number, which is what
   * made "we both want to be at this" invisible to the one screen where it is
   * a reason to talk.
   *
   * Intent is the union of the two tables: an RSVP is the stronger statement
   * and a favourite is the commoner one, and somebody in both should count
   * once. `COMMITTED` excludes `not_going`, which is a decline and the
   * opposite of a shared plan.
   *
   * Future only, and never this event — everyone in the room shares this one,
   * so counting it would add a constant to every candidate and change nothing
   * except to make the number look bigger.
   */
  const planRows =
    candidateIds.length > 0
      ? await db.$queryRaw<{ user_id: string; shared: bigint }[]>`
          WITH mine AS (
            SELECT event_id FROM event_rsvps
              WHERE user_id = ${viewerId} AND status IN ('going', 'maybe', 'waitlisted')
            UNION
            SELECT event_id FROM event_favorites WHERE user_id = ${viewerId}
          ),
          theirs AS (
            SELECT user_id, event_id FROM event_rsvps
              WHERE user_id = ANY(${candidateIds}) AND status IN ('going', 'maybe', 'waitlisted')
            UNION
            SELECT user_id, event_id FROM event_favorites WHERE user_id = ANY(${candidateIds})
          )
          SELECT t.user_id, COUNT(DISTINCT t.event_id) AS shared
            FROM theirs t
            JOIN events e ON e.id = t.event_id
           WHERE t.event_id IN (SELECT event_id FROM mine)
             AND t.event_id <> ${eventId}::uuid
             AND e.kind = 'event'
             AND e.start_time > now()
             AND e.deleted_at IS NULL
        GROUP BY t.user_id
        `
      : []
  const plansOf = new Map(planRows.map((r) => [r.user_id, Number(r.shared)]))

  /*
   * Attention already received, so the room's remaining attention can be spent
   * on somebody else.
   *
   * Likes come from Postgres — `@@index([event_id, liked_id])` already exists
   * for the mutual check — and impressions from Redis, because they are written
   * on the hottest read in the product and are a heuristic rather than data.
   * Both degrade to zero rather than throwing: a deck that ranks as it did
   * before this existed is worse, not broken.
   */
  const [likeRows, exposures] = await Promise.all([
    db.event_likes.groupBy({
      by: ["liked_id"],
      where: { event_id: eventId, liked_id: { in: candidateIds } },
      _count: { _all: true },
    }),
    exposuresFor(eventId, candidateIds),
  ])
  const likesOf = new Map(likeRows.map((r) => [r.liked_id, r._count._all]))

  /*
   * What the cards may print beyond the score (lib/overlaps.ts): display
   * traits for the room, the IPL leaves, and the badges check-ins earned.
   * Read once for the whole room, like everything above.
   */
  const [traits, iplTeams] = await Promise.all([
    displayTraitsOf(
      new Map<string, TraitProfile | null | undefined>([
        [viewerId, viewerProfile],
        ...eligible.map((c) => [c.user_id, c.user.profile] as const),
      ])
    ),
    iplTeamIds(),
  ])
  const traitsOf = (id: string) => traits.get(id) ?? NO_TRAITS
  // The viewer's own Tier B only if it predates this check-in (H1).
  const viewerTraits = viewerTierB(traitsOf(viewerId), viewerProfile?.tier_b_changed_at, viewerCheckIn.check_in_time)
  const holders = traitHolders(eligible.map((c) => traitsOf(c.user_id)))
  /*
   * The floor counts who is inside NOW, plus the viewer (step 10 review M1):
   * the deck keeps people who went home, and two people left in a room of
   * twenty are two, whatever the deck says. Rarity keeps the whole deck.
   */
  const peopleInside = eligible.filter((c) => c.status === "checked_in").length + 1
  const leadTeam = roomTeam(iplTeams, interestHolders, peopleInside >= MIN_ROOM_FOR_WORK_FIELD)
  const viewerInterestIds = expand(viewerInterests.map((i) => i.category_id))

  const candidates: MatchCandidate[] = eligible.map((c) => ({
    userId: c.user_id,
    sharedEvents: sharedOf.get(c.user_id) ?? 0,
    sharedPlans: plansOf.get(c.user_id) ?? 0,
    exposures: exposures.get(c.user_id) ?? 0,
    likesReceived: likesOf.get(c.user_id) ?? 0,
    // Neither feeds the ranking: both are filled in for the page below.
    pseudonym: "Attendee",
    interestIds: expand(c.user.user_interests.map((i) => i.category_id)),
    intents: effectiveIntents(
      prefsOf.get(c.user_id)?.intent ?? [],
      c.user.profile?.intent_default ?? []
    ),
    workField: c.user.profile?.work_field ?? null,
    age: ageFrom(c.user.profile),
    dating: {
      gender: (c.user.profile?.gender ?? null) as Gender | null,
      interestedIn: (c.user.profile?.interested_in ?? []) as Gender[],
    },
    insideNow: c.status === "checked_in",
    checkedInAt: c.check_in_time!,
    revealed: false,
    name: c.user.name,
    /*
     * `photos[0]`, full stop.
     *
     * This was `photos?.[0] ?? c.user.image`, which made the card and the DM
     * disagree: conversations read `user.image` alone, so a Google avatar
     * counted as a face here and not there. `User.image` is now a mirror of
     * this same value, written only by `PUT /profiles`, so the fallback can
     * only ever return stale data.
     */
    photo: c.user.profile?.photos?.[0] ?? null,
  }))

  const viewer = {
    userId: viewerId,
    interestIds: viewerInterestIds,
    intents: effectiveIntents(prefsOf.get(viewerId)?.intent ?? [], viewerProfile?.intent_default ?? []),
    workField: viewerProfile?.work_field ?? null,
    dating: {
      gender: (viewerProfile?.gender ?? null) as Gender | null,
      interestedIn: (viewerProfile?.interested_in ?? []) as Gender[],
    },
  }
  const rankOpts = { interestHolders, parentOf, population: eligible.length, peopleInside, limit }

  /*
   * Rank the room, then name the page.
   *
   * Who a card names (`visibleInRoom`: blocks and closed pairs beat a reveal,
   * as on the roster) and its pseudonym only decide how a card is DISPLAYED,
   * never where it sorts, so asking them of the whole room was five lists and
   * a member read of O(room) to label `limit` cards. Ask them of the page and
   * rank that page again with the answers: every score is the candidate's own
   * and `population` / `interestHolders` / `peopleInside` are passed in, so the
   * page ranks to the same order and the same cards.
   */
  const page = rankMatches(viewer, candidates, rankOpts)
  const pageIds = page.map((m) => m.userId)
  const [recognised, pseudonyms] = await Promise.all([
    visibleInRoom(viewerId, eventId, pageIds),
    pageIds.length
      ? db.chat_group_members.findMany({
          where: { chat_group: { event_id: eventId }, user_id: { in: pageIds } },
          select: { user_id: true, anonymous_name: true },
        })
      : [],
  ])
  const pseudonymOf = new Map(pseudonyms.map((p) => [p.user_id, p.anonymous_name || "Attendee"]))
  const onPage = new Set(pageIds)
  const ranked = rankMatches(
    viewer,
    candidates
      .filter((c) => onPage.has(c.userId))
      .map((c) => ({ ...c, pseudonym: pseudonymOf.get(c.userId) ?? "Attendee", revealed: recognised.has(c.userId) })),
    rankOpts
  )

  // Category names, resolved once for the whole page rather than per card.
  const sharedIds = [...new Set(ranked.flatMap((m) => m.sharedInterestIds))]
  const categories = sharedIds.length
    ? await db.categories.findMany({
        where: { id: { in: sharedIds } },
        select: { id: true, name: true },
      })
    : []
  const nameOf = new Map(categories.map((c) => [c.id, c.name]))

  /*
   * Record that these were shown, and do NOT await it.
   *
   * The deck must not wait on a counter, and it must not fail on one: an
   * impression that goes unrecorded costs a little balancing accuracy, while a
   * deck that fails to render costs the feature. `recordImpressions` already
   * swallows its own errors; the `catch` here is belt and braces against an
   * unhandled rejection taking the process down.
   *
   * Only the page actually returned. Counting the whole ranked room would
   * penalise everybody equally on every request, which is the same as counting
   * nobody — and would make the damping a function of how often the deck is
   * opened rather than of who was seen.
   */
  void recordImpressions(
    eventId,
    ranked.map((m) => m.userId)
  ).catch(() => {})

  const interestsOf = new Map(candidates.map((c) => [c.userId, c.interestIds]))
  const profileOf = new Map(eligible.map((c) => [c.user_id, c.user.profile]))

  /*
   * Badges for the page that is returned, never the whole room (step 10
   * review M6): two set-based reads over at most `limit` people. Only for those
   * who did not turn badges off, and "Shows up" only for those who turned it on.
   */
  const badgeFacts = await badgeFactsFor(
    eventId,
    ranked.filter((m) => m.roomIsBigEnough && profileOf.get(m.userId)?.show_badges !== false).map((m) => m.userId),
    ranked.filter((m) => profileOf.get(m.userId)?.shows_up_badge).map((m) => m.userId)
  )

  return ranked.map((m) => {
    const card = personCard(
      { traits: viewerTraits, interestIds: viewerInterestIds },
      { traits: traitsOf(m.userId), interestIds: interestsOf.get(m.userId) ?? [] },
      { holders, interestHolders, population: eligible.length, iplTeams, roomTeam: leadTeam },
      m.labelBudget
    )
    return {
      /*
       * Their handle in this room, never the real id (SCRUM-371). The viewer is
       * never in their own deck, so every card is somebody else's. The same
       * string as the roster's and `room:match`'s, and `POST /matches/likes`
       * takes it back.
       */
      userId: roomHandle(eventId, m.userId),
      displayName: m.displayName,
      photo: m.photo,
      sharedInterests: m.sharedInterestIds.map((id) => nameOf.get(id) ?? id),
      sharedIntents: m.sharedIntents,
      // `rankMatches` has applied the small-room floor; the card's Tier B slot
      // decides whether the field shows at all (`personCard`, step 10 review M3).
      workField: card.showWorkField ? workFieldLabel(m.workField) : null,
      sharedWorkField: card.showWorkField && m.sharedWorkField,
      age: m.age,
      insideNow: m.insideNow,
      // Already floored by `rankMatches` — this only carries it to the card.
      sharedEvents: m.sharedEvents,
      sharedPlans: m.sharedPlans,
      youLiked: liked.has(m.userId),
      overlaps: card.overlaps,
      sign: card.sign,
      // Attendance facts, so the attendance floor (`roomIsBigEnough`), and only if they show badges.
      badges:
        m.roomIsBigEnough && profileOf.get(m.userId)?.show_badges !== false ? badgesFor(badgeFacts(m.userId)) : [],
    }
  })
}

/**
 * The check-in facts behind the badges, for a room's candidates, in two
 * set-based reads (lib/overlaps.ts `badgesFor`).
 *
 * Nights are distinct occurrences checked into as an attendee — a venue day
 * counts, it is a night out. "Here" is this event's venue, which a venue day
 * has too; an event with no venue has no "Regular here". "Shows up" reads only
 * the people who turned it on, and only past, uncancelled events they said
 * they were going to.
 */
export async function badgeFactsFor(
  eventId: string | null,
  candidateIds: readonly string[],
  showsUpOptIns: readonly string[]
) {
  const day = 24 * 60 * 60 * 1000
  const now = Date.now()
  // No event, as on a profile, is no venue: no "Regular here", which is about the room you are in.
  const event = eventId ? await db.events.findUnique({ where: { id: eventId }, select: { venue_id: true } }) : null
  const venueId = event?.venue_id ?? null
  const [nights, rsvps] = await Promise.all([
    candidateIds.length
      ? // any-kind: a night out at a venue's Go Live is a night out, and a regular there is a regular (§8.6)
        db.$queryRaw<{ user_id: string; nights_out: bigint; nights_here: bigint }[]>`
          SELECT ci.user_id,
                 COUNT(DISTINCT ci.occurrence_id) FILTER (WHERE ci.check_in_time >= ${new Date(now - NIGHTS_OUT_DAYS * day)}) AS nights_out,
                 COUNT(DISTINCT ci.occurrence_id) FILTER (WHERE e.venue_id = ${venueId}::uuid) AS nights_here
            FROM event_check_ins ci
            JOIN events e ON e.id = ci.event_id
           WHERE ci.user_id = ANY(${[...candidateIds]})
             AND ci.kind = 'attendee'
             AND ci.check_in_time >= ${new Date(now - Math.max(NIGHTS_OUT_DAYS, REGULAR_HERE_DAYS) * day)}
        GROUP BY ci.user_id
        `
      : [],
    showsUpOptIns.length
      ? db.$queryRaw<{ user_id: string; rsvps: bigint; attended: bigint }[]>`
          SELECT r.user_id,
                 COUNT(*) AS rsvps,
                 COUNT(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM event_check_ins ci
                    WHERE ci.event_id = r.event_id AND ci.user_id = r.user_id
                      AND ci.kind = 'attendee' AND ci.check_in_time IS NOT NULL
                 )) AS attended
            FROM event_rsvps r
            JOIN events e ON e.id = r.event_id
           WHERE r.user_id = ANY(${[...showsUpOptIns]})
             AND r.status = 'going'
             AND e.kind = 'event'
             AND e.deleted_at IS NULL
             AND e.status <> 'cancelled'
             AND e.end_time < now()
             AND e.end_time >= ${new Date(now - SHOWS_UP_DAYS * day)}
        GROUP BY r.user_id
        `
      : [],
  ])
  const nightsOf = new Map(nights.map((r) => [r.user_id, r]))
  const rsvpsOf = new Map(rsvps.map((r) => [r.user_id, r]))
  const optedIn = new Set(showsUpOptIns)
  return (userId: string) => ({
    nightsHere: venueId ? Number(nightsOf.get(userId)?.nights_here ?? 0) : null,
    nightsOut: Number(nightsOf.get(userId)?.nights_out ?? 0),
    rsvpsPast: Number(rsvpsOf.get(userId)?.rsvps ?? 0),
    rsvpsAttended: Number(rsvpsOf.get(userId)?.attended ?? 0),
    showsUpOptIn: optedIn.has(userId),
  })
}

export interface LikeOutcome {
  mutual: boolean
  /** Present only on a mutual like — the conversation it just opened. */
  conversationId?: string
  /**
   * Both pseudonyms, on a mutual like only.
   *
   * The app's Connection Success sheet draws a generated mark for each person,
   * and `pseudonymAvatar` is seeded on the pseudonym. Without these it would
   * have to fetch the conversation before it could paint — a round trip in the
   * middle of the one moment in the product that should feel instant.
   *
   * Free to send: `likeAtEvent` already loads both rows to snapshot them onto
   * the conversation. This returns what it just computed.
   *
   * Pseudonyms, never names. `you` is the caller's own, which they already know.
   */
  pseudonyms?: { you: string; them: string }
}

/**
 * Like someone you were in a room with.
 *
 * A mutual like is the moment a conversation opens, and the only moment
 * identity is exchanged. It stands in for the message request rather than
 * bypassing it: a request exists to establish that both people consented to
 * talk, and two likes are exactly that, arrived at without either side having to
 * compose an opener to a stranger.
 *
 * **What this deliberately never tells you is whether they liked you first.**
 * Surfacing that turns the whole thing into a different product — one where the
 * interesting information is behind a payment — and it removes the only reason
 * the gesture means anything.
 */
export async function likeAtEvent(
  eventId: string,
  likerId: string,
  likedId: string
): Promise<LikeOutcome> {
  await db.event_likes.upsert({
    where: { event_id_liker_id_liked_id: { event_id: eventId, liker_id: likerId, liked_id: likedId } },
    create: { event_id: eventId, liker_id: likerId, liked_id: likedId },
    update: {},
  })

  /*
   * Not a match when the pair already have anything between them
   * (`pairIsLinked`: a friendship, any conversation open or closed, any friend
   * request). Opening one would hand back the existing DM — its id on the
   * like's response and on `room:match` says which card is the friend, or which
   * real-name thread this is — and a second pseudonymous DM would link this
   * event's pseudonyms to the first's. They already have somewhere to talk. The
   * like is recorded and the answer is that of a like nobody returned.
   *
   * Everything from here is under the pair's lock (`lockPair`), so a request or
   * an accept cannot land between the check and the write, and the linked check
   * runs BEFORE the reciprocal-like lookup: a like that was returned and one that
   * was not do the same work up to that point, so how long it takes says nothing
   * about whether the other person liked back.
   *
   * A closed pair is linked too, which is the invariant the old closed-pair
   * guard defended: `POST /matches/likes` refuses closed pairs before calling in,
   * but this is the shared write path.
   */
  try {
    const opened = await db.$transaction(async (tx) => {
      await lockPair(tx, likerId, likedId)
      const linked = await pairIsLinked(tx, likerId, likedId)
      const back = await tx.event_likes.findUnique({
        where: { event_id_liker_id_liked_id: { event_id: eventId, liker_id: likedId, liked_id: likerId } },
        select: { id: true },
      })
      if (!back || linked) return null

      /*
       * The pseudonyms and room-reveal state, snapshotted at the moment of the
       * match.
       *
       * Both come from this event: the pseudonym because a DM outlives its event
       * and the chat lifecycle sweeper deletes old groups, so a lookup would go
       * null exactly when the history matters; the reveal because somebody
       * already public in this room has nothing left to reveal to a person who
       * saw their card, and pretending otherwise would be theatre.
       */
      const [pseudonymRows, revealedRows] = await Promise.all([
        tx.chat_group_members.findMany({
          where: { chat_group: { event_id: eventId }, user_id: { in: [likerId, likedId] } },
          select: { user_id: true, anonymous_name: true },
        }),
        tx.event_match_preferences.findMany({
          where: { event_id: eventId, user_id: { in: [likerId, likedId] }, revealed: true },
          select: { user_id: true },
        }),
      ])
      const conversation = await openConversation(
        likerId,
        likedId,
        {
          eventId,
          // A pseudonym this room never gave is "Attendee", never null: a null reads as real names.
          pseudonyms: Object.fromEntries(pseudonymRows.map((p) => [p.user_id, p.anonymous_name || "Attendee"])),
          revealed: revealedRows.map((r) => r.user_id),
        },
        tx
      )
      return { conversation, pseudonymRows }
    })
    if (!opened) return { mutual: false }
    const { conversation, pseudonymRows } = opened
    /*
     * Only the EARLIER liker gets the push.
     *
     * The person who just tapped Like is holding the phone and gets the mutual
     * back in this response — notifying them is a notification for something
     * they are already looking at. `likedId` is the one who liked first (that
     * is what `back` proved) and does not know yet.
     *
     * Fire and forget: a push failure must never fail the like that caused it.
     */
    notifyMatch(likedId, conversation.id).catch(() => {})

    const byUser = new Map(pseudonymRows.map((p) => [p.user_id, p.anonymous_name || "Attendee"]))
    return {
      mutual: true,
      conversationId: conversation.id,
      pseudonyms: {
        you: byUser.get(likerId) || "Attendee",
        them: byUser.get(likedId) || "Attendee",
      },
    }
  } catch (e) {
    if (e instanceof ConversationClosedError) return { mutual: false }
    throw e
  }
}

/**
 * Going public in a room carries into the DMs already opened from it.
 *
 * Somebody who reveals mid-event has shown their name and face to everyone
 * there — including people they already matched with — so a DM still calling
 * them by their pseudonym would protect nothing. Monotonic: `revealed: false`
 * in the filter leaves a revealed side alone, and nothing here ever hides a
 * name again (D-10: a reveal can't be unseen).
 */
export async function revealConversationsFrom(eventId: string, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return
  const ids = [...userIds]
  // Read first: updateMany does not say which rows it moved, and only those are told.
  const pending = await db.private_conversations.findMany({
    where: {
      origin_event_id: eventId,
      closed_at: null,
      OR: [
        { user1_id: { in: ids }, user1_revealed: false },
        { user2_id: { in: ids }, user2_revealed: false },
      ],
    },
    select: { id: true, user1_id: true, user2_id: true, user1_revealed: true, user2_revealed: true },
  })
  await Promise.all([
    db.private_conversations.updateMany({
      where: { origin_event_id: eventId, user1_id: { in: ids }, user1_revealed: false, closed_at: null },
      data: { user1_revealed: true },
    }),
    db.private_conversations.updateMany({
      where: { origin_event_id: eventId, user2_id: { in: ids }, user2_revealed: false, closed_at: null },
      data: { user2_revealed: true },
    }),
  ])
  for (const c of pending) {
    const flipped1 = !c.user1_revealed && ids.includes(c.user1_id)
    const flipped2 = !c.user2_revealed && ids.includes(c.user2_id)
    const bothNow = (c.user1_revealed || flipped1) && (c.user2_revealed || flipped2)
    // The other side of each flip; both sides once the pair is mutual (the friend offer opens).
    const told = bothNow ? [c.user1_id, c.user2_id] : [...(flipped1 ? [c.user2_id] : []), ...(flipped2 ? [c.user1_id] : [])]
    emitPrivateRevealed(c.id, told)
  }
  // A friend request held for one of these pairs may be deliverable now. Never
  // allowed to fail the reveal that caused it: a request this misses is still
  // delivered by the next read.
  await releaseHeldRequests(ids).catch(() => undefined)
}
