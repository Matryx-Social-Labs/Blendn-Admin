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
 */
export async function maySeeIdentity(viewerId: string, targetId: string): Promise<boolean> {
  if (viewerId === targetId) return true

  const [mutualLike, conversation, revealedToViewer, closed] = await Promise.all([
    // A like in each direction, at the same event.
    db.event_likes
      .findFirst({
        where: {
          liker_id: viewerId,
          liked_id: targetId,
          event: { likes: { some: { liker_id: targetId, liked_id: viewerId } } },
        },
        select: { id: true },
      })
      .then(Boolean),

    /*
     * A **live** conversation. Closing has to reach this gate too.
     *
     * Both branches above and this one outlive a soft close — the row is
     * retained for moderation and the mutual likes are never deleted — so
     * without these filters, unmatching would leave the other person able to
     * pull your real name, photos and profile from `GET /users/:id` forever.
     * That is the one thing leaving is supposed to stop.
     */
    db.private_conversations
      .findFirst({
        where: {
          closed_at: null,
          OR: [
            { user1_id: viewerId, user2_id: targetId },
            { user1_id: targetId, user2_id: viewerId },
          ],
        },
        select: { id: true },
      })
      .then(Boolean),

    // They revealed at an event the viewer also checked into.
    //
    // Reads `event_match_preferences`, which holds one answer per person per
    // event. It used to read `event_check_ins.revealed`, where a multi-day
    // event gave one person several rows — so whether you could see someone's
    // name depended on which of their check-ins matched first.
    db.event_match_preferences
      .findFirst({
        where: {
          user_id: targetId,
          revealed: true,
          event: { check_ins: { some: { user_id: viewerId } } },
        },
        select: { id: true },
      })
      .then(Boolean),

    /*
     * Did this pair leave each other?
     *
     * Fetched separately rather than folded into the branches above because it
     * **overrides all of them**. `event_likes` are never deleted, so a mutual
     * like survives an unmatch and would keep the first branch true forever;
     * and someone who was public in a shared room stays public there, so the
     * third branch would too. Leaving has to beat both, or "they can no longer
     * see who I am" is false in the two most common ways of having met.
     */
    db.private_conversations
      .findFirst({
        where: {
          closed_at: { not: null },
          OR: [
            { user1_id: viewerId, user2_id: targetId },
            { user1_id: targetId, user2_id: viewerId },
          ],
        },
        select: { id: true },
      })
      .then(Boolean),
  ])

  if (closed) return false
  return mutualLike || conversation || revealedToViewer
}
