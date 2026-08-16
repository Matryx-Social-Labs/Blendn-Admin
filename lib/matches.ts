import { ConversationClosedError, closedPairKeys, openConversation } from "@/lib/conversations"
import { db } from "@/lib/db"
import { notifyMatch } from "@/lib/push-notifications"
import {
  effectiveIntents,
  rankMatches,
  type Intent,
  type MatchCandidate,
} from "@/lib/matching"
import type { Gender } from "@/lib/dating"
import { ageFrom } from "@/lib/age"
import { workFieldLabel } from "@/lib/work-fields"

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
    where: { event_id: eventId, user_id: viewerId, check_in_time: { not: null } },
    select: { id: true },
  })
  if (!viewerCheckIn) return null

  const [viewerProfile, viewerInterests, checkIns, prefs, blocks, closedPairs, likes] =
    await Promise.all([
    db.profiles.findUnique({
      where: { id: viewerId },
      select: { intent_default: true, work_field: true, gender: true, interested_in: true },
    }),
    db.user_interests.findMany({ where: { user_id: viewerId }, select: { category_id: true } }),
    db.event_check_ins.findMany({
      where: {
        event_id: eventId,
        check_in_time: { not: null },
        // Staff are working, not mingling. They are excluded from attendance for
        // the same reason and it would be strange to offer the bar manager as a
        // match.
        kind: "attendee",
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
                work_field: true,
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
      select: { user_id: true, intent: true, revealed: true },
    }),
    db.blocked_users.findMany({
      where: { OR: [{ blocker_id: viewerId }, { blocked_id: viewerId }] },
      select: { blocker_id: true, blocked_id: true },
    }),
    // Leaving is permanent: an unmatched pair never appears to each other
    // again. Same `hidden` set as blocks below -- one exclusion, two reasons.
    closedPairKeys(viewerId),
    db.event_likes.findMany({
      where: { event_id: eventId, liker_id: viewerId },
      select: { liked_id: true },
    }),
  ])

  // Blocks hide people in both directions. Someone you blocked should not
  // reappear as a suggestion, and neither should someone who blocked you.
  const hidden = new Set([
    ...blocks.map((b) => (b.blocker_id === viewerId ? b.blocked_id : b.blocker_id)),
    ...closedPairs,
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
  const parentOf = new Map<string, string>()
  for (const row of await db.categories.findMany({
    where: { parent_id: { not: null } },
    select: { id: true, parent_id: true },
  })) {
    parentOf.set(row.id, row.parent_id!)
  }

  /**
   * A held set, plus the parents those holdings imply. Deduplicated.
   *
   * Used for **both** the holder counts and the interest lists handed to
   * ranking, and it has to be both. Storage is leaf-only, so without expanding
   * the lists too, someone into "IPL screening" and someone into "Running"
   * would intersect on nothing — the shared "Sports" that this whole stage
   * exists to find is not in either raw row.
   */
  const expand = (ids: readonly string[]): string[] => {
    const held = new Set<string>()
    for (const id of ids) {
      held.add(id)
      const parent = parentOf.get(id)
      if (parent) held.add(parent)
    }
    return [...held]
  }

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

  const pseudonyms = await db.chat_group_members.findMany({
    where: { chat_group: { event_id: eventId } },
    select: { user_id: true, anonymous_name: true },
  })
  const pseudonymOf = new Map(pseudonyms.map((p) => [p.user_id, p.anonymous_name || "Attendee"]))

  const candidates: MatchCandidate[] = eligible.map((c) => ({
    userId: c.user_id,
    pseudonym: pseudonymOf.get(c.user_id) ?? "Attendee",
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
    revealed: prefsOf.get(c.user_id)?.revealed ?? false,
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

  const ranked = rankMatches(
    {
      userId: viewerId,
      interestIds: expand(viewerInterests.map((i) => i.category_id)),
      intents: effectiveIntents(
        prefsOf.get(viewerId)?.intent ?? [],
        viewerProfile?.intent_default ?? []
      ),
      workField: viewerProfile?.work_field ?? null,
      dating: {
        gender: (viewerProfile?.gender ?? null) as Gender | null,
        interestedIn: (viewerProfile?.interested_in ?? []) as Gender[],
      },
    },
    candidates,
    { interestHolders, parentOf, population: eligible.length, limit }
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

  return ranked.map((m) => ({
    userId: m.userId,
    displayName: m.displayName,
    photo: m.photo,
    sharedInterests: m.sharedInterestIds.map((id) => nameOf.get(id) ?? id),
    sharedIntents: m.sharedIntents,
    // `rankMatches` has already applied the small-room floor; this only turns
    // the surviving slug into something a person can read.
    workField: workFieldLabel(m.workField),
    age: m.age,
    insideNow: m.insideNow,
    youLiked: liked.has(m.userId),
  }))
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

  const back = await db.event_likes.findUnique({
    where: { event_id_liker_id_liked_id: { event_id: eventId, liker_id: likedId, liked_id: likerId } },
    select: { id: true },
  })
  if (!back) return { mutual: false }

  /*
   * A closed pair can still reach here.
   *
   * `POST /matches/likes` refuses closed pairs before calling in, and closed
   * pairs are hidden from the ranked list -- but this function is the shared
   * write path, and defending the invariant where it lives beats trusting every
   * present and future caller to have checked. `mutual: false` is the honest
   * answer: the like is recorded, and there is no conversation to point at.
   */
  /*
   * The pseudonyms and room-reveal state, snapshotted at the moment of the
   * match.
   *
   * Both come from this event: the pseudonym because a DM outlives its event
   * and the chat lifecycle sweeper deletes old groups, so a lookup would go
   * null exactly when the history matters; the reveal because somebody already
   * public in this room has nothing left to reveal to a person who saw their
   * card, and pretending otherwise would be theatre.
   */
  const [pseudonymRows, revealedRows] = await Promise.all([
    db.chat_group_members.findMany({
      where: { chat_group: { event_id: eventId }, user_id: { in: [likerId, likedId] } },
      select: { user_id: true, anonymous_name: true },
    }),
    db.event_match_preferences.findMany({
      where: { event_id: eventId, user_id: { in: [likerId, likedId] }, revealed: true },
      select: { user_id: true },
    }),
  ])

  try {
    const conversation = await openConversation(likerId, likedId, {
      eventId,
      pseudonyms: Object.fromEntries(
        pseudonymRows.map((p) => [p.user_id, p.anonymous_name || "Attendee"])
      ),
      revealed: revealedRows.map((r) => r.user_id),
    })
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
