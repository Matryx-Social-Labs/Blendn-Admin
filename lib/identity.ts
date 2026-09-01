import { db } from "@/lib/db"

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
 * ## Why the id stays
 *
 * The obvious fix is a per-event opaque handle, and it is the wrong first move:
 * the id is what the client passes to block, report and open a message request,
 * so replacing it changes the mobile contract everywhere at once. The id was
 * never the secret. **The lookup was.**
 *
 * So the id keeps flowing and identity becomes relationship-gated. A per-event
 * handle is still worth doing later for defence in depth -- an id that never
 * leaves the server cannot be correlated across events -- but it is no longer
 * load-bearing.
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
 * `maySeeIdentity` runs five queries. Every surface that resolves identity is a
 * **list** — the roster, the participants list, the match deck, the blocked
 * list — so a singular gate invites `list.map(maySeeIdentity)`, which is five
 * queries per person and looks completely correct in review. That is exactly
 * what `GET /users/blocked` was doing.
 *
 * So the plural version is the implementation and the singular one is a wrapper
 * over it. Two implementations of one question is the shape of the bug this
 * module exists to fix, and it would arrive here first: the singular is the one
 * everybody reaches for, so it is the one that would drift.
 *
 * Five queries regardless of how many people are asked about. The mutual-like
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

  const [sent, received, conversations, revealed, blocks] = await Promise.all([
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
      select: { user1_id: true, user2_id: true, closed_at: true },
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
    ;(c.closed_at === null ? open : closed).add(other)
  }

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
    if (mutual.has(id) || open.has(id) || revealedTo.has(id)) visible.add(id)
  }
  return visible
}

export async function maySeeIdentity(viewerId: string, targetId: string): Promise<boolean> {
  /*
   * A wrapper, deliberately. The rule lives in `maySeeIdentityFor` and this
   * asks it about one person, so the two can never answer differently — which
   * they would, eventually, if both held a copy of five branches whose ordering
   * and overrides are the whole point.
   */
  return (await maySeeIdentityFor(viewerId, [targetId])).has(targetId)
}

