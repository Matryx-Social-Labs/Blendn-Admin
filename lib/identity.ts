import { db } from "@/lib/db"
import { resolveUserRef } from "@/lib/room-handle"

/**
 * Who may see whose real name and face.
 *
 * ## The hole this closes
 *
 * The room is pseudonymous, and every room surface returned the **real user id**
 * beside the pseudonym -- the roster, the chat participant list, every message
 * author, every reaction. The check-ins route said in a comment that "the id
 * alone discloses nothing". It disclosed everything, because
 * `GET /users/:userId` took any valid mobile token and returned the real name,
 * photos, bio and occupation behind it. Two requests turned "Cosmic Panda" into
 * a named person with a face, for the whole room at once.
 *
 * That mattered beyond the roster: the same join attributed every message in
 * the chatroom -- the ones the sentiment classifier reads, and the ones
 * `lib/trust.ts` cites as the reason peer ratings are never surfaced.
 *
 * ## Why the id went too
 *
 * The first fix was this gate, and it said the id could stay: the client passes
 * it to block, report and open a message request, and without the lookup it
 * "bought nothing". A per-event handle was left as defence in depth for later.
 *
 * Friends made it load-bearing. A friend holds your real id, so the id beside a
 * pseudonym told them which card was you — past `friends_see_me_in_rooms`, and
 * without asking this gate anything. Every room surface now sends a per-event
 * room handle for anyone but the viewer (`lib/room-handle.ts`, SCRUM-371), and
 * every endpoint that took an id takes a handle. This gate is still the one
 * that decides who sees a name; the handle only stops the id answering first.
 * `userIdFromRefIfIdentified` below keeps a handle from being worth more than
 * this gate allows on the routes whose answer turns on a friendship.
 *
 * ## The rule
 *
 * You see someone's real identity when one of these is true, and not otherwise:
 *
 * - **It is you.**
 * - **You matched.** A mutual like at a shared event. This is the documented
 *   exchange: "if two people both like each other, a conversation opens and
 *   identity is exchanged".
 * - **You are in a conversation.** An accepted message request already required
 *   co-presence and consent from the other side.
 * - **They chose to be public in a room you were in.** `event_check_ins.revealed`
 *   is someone opting out of the pseudonym for that event, so it would be
 *   strange to keep hiding them from the people who were there.
 * - **You are friends and they let friends recognise them in rooms**
 *   (`profiles.friends_see_me_in_rooms`, default off). Friendship alone is not
 *   a branch, and neither is a DM opened between friends — see `lib/friends.ts`.
 *
 * Co-presence alone is deliberately *not* enough. Sharing a room is what lets
 * you send a request; it is not consent to be identified.
 *
 * **A block in either direction beats all four.** Reveal is otherwise one-way
 * and non-retractable; blocking is the single way to un-tell one person.
 */
/**
 * The same rule, asked about many people at once.
 *
 * ## Why the plural one is the real one
 *
 * `maySeeIdentity` runs six queries. Every surface that resolves identity is a
 * **list** — the roster, the participants list, the match deck, the blocked
 * list — so a singular gate invites `list.map(maySeeIdentity)`, which is six
 * queries per person and looks completely correct in review. That is exactly
 * what `GET /users/blocked` was doing.
 *
 * So the plural version is the implementation and the singular one is a wrapper
 * over it. Two implementations of one question is the shape of the bug this
 * module exists to fix, and it would arrive here first: the singular is the one
 * everybody reaches for, so it is the one that would drift.
 *
 * Six queries regardless of how many people are asked about. The mutual-like
 * check costs two, because "we liked each other at the same event" cannot be
 * expressed as one Prisma query over a *set* of targets — the inner filter
 * would have to reference the outer row's `liked_id`. Both directions are
 * fetched and intersected on `(event_id, other_person)` instead, which is the
 * same predicate the singular version expresses as a correlated subquery.
 */
export async function maySeeIdentityFor(
  viewerId: string,
  targetIds: string[]
): Promise<Set<string>> {
  const visible = new Set<string>()
  const others = [...new Set(targetIds)].filter((id) => id !== viewerId)
  // It is always you. Added unconditionally so a caller passing only themselves
  // does no queries at all.
  if (targetIds.includes(viewerId)) visible.add(viewerId)
  if (others.length === 0) return visible

  const [sent, received, conversations, revealed, blocks, friendsOptedIn] = await Promise.all([
    db.event_likes.findMany({
      where: { liker_id: viewerId, liked_id: { in: others } },
      select: { event_id: true, liked_id: true },
    }),
    db.event_likes.findMany({
      where: { liked_id: viewerId, liker_id: { in: others } },
      select: { event_id: true, liker_id: true },
    }),

    /*
     * Open and closed in one read, because the fold needs both and they differ
     * only by a predicate. `closed_at` overrides every positive branch — see
     * the singular version's reasoning, which this must not restate wrongly.
     */
    db.private_conversations.findMany({
      where: {
        OR: [
          { user1_id: viewerId, user2_id: { in: others } },
          { user2_id: viewerId, user1_id: { in: others } },
        ],
      },
      select: { user1_id: true, user2_id: true, closed_at: true, origin_friendship: true },
    }),

    /*
     * They revealed at an event the viewer also checked into.
     *
     * Reads `event_match_preferences`, which holds one answer per person per
     * event. It used to read `event_check_ins.revealed`, where a multi-day
     * event gave one person several rows — so whether you could see someone's
     * name depended on which of their check-ins matched first.
     */
    db.event_match_preferences.findMany({
      where: {
        user_id: { in: others },
        revealed: true,
        event: { check_ins: { some: { user_id: viewerId } } },
      },
      select: { user_id: true },
    }),

    /*
     * A block, in **either** direction, because the harm is symmetric: the
     * person who blocked does not want to see, and the person blocked must not
     * be seen.
     */
    db.blocked_users.findMany({
      where: {
        OR: [
          { blocker_id: viewerId, blocked_id: { in: others } },
          { blocked_id: viewerId, blocker_id: { in: others } },
        ],
      },
      select: { blocker_id: true, blocked_id: true },
    }),

    /*
     * Friends who chose to be recognisable to their friends in a room.
     *
     * Only those: being friends is not, by itself, a way to see who somebody
     * is here. Every caller of this function is a room surface or answers for
     * one, and somebody at a singles night may not want the people they know
     * to learn which card is theirs. `friends_see_me_in_rooms` is theirs to
     * turn on, and it defaults off.
     */
    db.friendships.findMany({
      where: {
        OR: [
          { user1_id: viewerId, user2_id: { in: others }, user2: { profile: { friends_see_me_in_rooms: true } } },
          { user2_id: viewerId, user1_id: { in: others }, user1: { profile: { friends_see_me_in_rooms: true } } },
        ],
      },
      select: { user1_id: true, user2_id: true },
    }),
  ])

  const sentAt = new Set(sent.map((r) => `${r.event_id}:${r.liked_id}`))
  const mutual = new Set(
    received
      .filter((r) => sentAt.has(`${r.event_id}:${r.liker_id}`))
      .map((r) => r.liker_id)
  )

  const open = new Set<string>()
  const closed = new Set<string>()
  for (const c of conversations) {
    const other = c.user1_id === viewerId ? c.user2_id : c.user1_id
    if (c.closed_at !== null) closed.add(other)
    /*
     * A DM two friends opened from the friends list is not "in a
     * conversation" for this purpose. If it were, the first message between
     * friends would make them recognisable to each other in every room after
     * — undoing `friends_see_me_in_rooms` for anyone who ever said hello.
     * Closed still counts as closed above: leaving beats everything.
     */
    else if (!c.origin_friendship) open.add(other)
  }
  const friendVisible = new Set(
    friendsOptedIn.map((f) => (f.user1_id === viewerId ? f.user2_id : f.user1_id))
  )

  const revealedTo = new Set(revealed.map((r) => r.user_id))
  const blocked = new Set(
    blocks.map((b) => (b.blocker_id === viewerId ? b.blocked_id : b.blocker_id))
  )

  /*
   * Blocked and closed override every positive branch, and that ordering is the
   * load-bearing part of this function rather than an implementation detail.
   *
   * `event_likes` are never deleted, so a mutual like survives an unmatch and
   * would keep the first branch true forever; someone who was public in a
   * shared room stays public there, so the reveal branch would too. Leaving has
   * to beat both, or "they can no longer see who I am" is false in the two most
   * common ways of having met — and blocking somebody you had revealed to would
   * leave them able to pull your real name and photographs indefinitely, which
   * is the one thing blocking is supposed to stop.
   */
  for (const id of others) {
    if (blocked.has(id) || closed.has(id)) continue
    if (mutual.has(id) || open.has(id) || revealedTo.has(id) || friendVisible.has(id)) visible.add(id)
  }
  return visible
}

export async function maySeeIdentity(viewerId: string, targetId: string): Promise<boolean> {
  /*
   * A wrapper, deliberately. The rule lives in `maySeeIdentityFor` and this
   * asks it about one person, so the two can never answer differently — which
   * they would, eventually, if both held a copy of six branches whose ordering
   * and overrides are the whole point.
   */
  return (await maySeeIdentityFor(viewerId, [targetId])).has(targetId)
}


/**
 * The account behind a ref, for a route whose answer turns on a relationship
 * the room hides (SCRUM-371).
 *
 * A room handle names somebody as they appear in one room. Most routes can
 * take it at face value — a block, a report, a like answer the same whoever it
 * is. These cannot: `GET /friends/:id` answers 200 for a friend and 404 for
 * anyone else, and `POST /conversations` returns an open friend DM's other
 * side by name. Handed every handle on a roster, either one picks out which
 * pseudonym is your friend — past the `friends_see_me_in_rooms` switch, whose
 * whole point is that they cannot.
 *
 * So a handle resolves here only for a viewer the room would let see who it
 * is. Otherwise it comes back unchanged, which no account id matches, and the
 * route answers exactly as it does for an id nobody has. A raw id is not
 * gated: whoever sends one already knows who it is, and learns nothing from a
 * room they did not use.
 */
export async function userIdFromRefIfIdentified(viewerId: string, ref: string): Promise<string> {
  const resolved = resolveUserRef(ref)
  if (!resolved) return ref
  if (resolved.eventId === null || resolved.userId === viewerId) return resolved.userId
  return (await maySeeIdentity(viewerId, resolved.userId)) ? resolved.userId : ref
}
