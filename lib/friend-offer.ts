import { db } from "@/lib/db"
import { mayShowRealName } from "@/lib/conversation-identity"
import { friendState, isRevealedMatch, revealedMatch, type FriendState } from "@/lib/friends"

/**
 * What a DM or a profile tells the app about adding this person as a friend.
 *
 * `canAdd` is the owner's rule (`revealedMatch`) and not already requested or
 * friends. `incoming` still counts as addable: asking someone who has asked you
 * is the accept (`requestFriend`).
 */
export interface FriendOffer {
  state: Exclude<FriendState, "self">
  canAdd: boolean
}

/** What a person the viewer cannot yet name gets: nothing to tell them apart by. */
const NOTHING: FriendOffer = { state: "none", canAdd: false }

const addable = (state: FriendOffer["state"]) => state === "none" || state === "incoming"

type Conversation = Parameters<typeof isRevealedMatch>[0] & {
  id: string
  user1_id: string
  user2_id: string
}

/**
 * The offer for each of the viewer's open conversations, in three queries
 * however many there are.
 *
 * While the other side is still a pseudonym to the viewer the answer is
 * `NOTHING`, whoever they really are: "this pseudonym is already your friend"
 * would name them.
 */
export async function friendOffersFor(viewerId: string, conversations: Conversation[]): Promise<Map<string, FriendOffer>> {
  const others = new Map(conversations.map((c) => [c.id, c.user1_id === viewerId ? c.user2_id : c.user1_id]))
  const ids = [...new Set(others.values())]
  if (ids.length === 0) return new Map()

  const [friendships, requests, blocks, live] = await Promise.all([
    db.friendships.findMany({
      where: { OR: [{ user1_id: viewerId, user2_id: { in: ids } }, { user2_id: viewerId, user1_id: { in: ids } }] },
      select: { user1_id: true, user2_id: true },
    }),
    db.friend_requests.findMany({
      where: {
        withdrawn_at: null,
        OR: [
          { sender_id: viewerId, recipient_id: { in: ids } },
          { recipient_id: viewerId, sender_id: { in: ids } },
        ],
      },
      select: { sender_id: true, recipient_id: true },
    }),
    db.blocked_users.findMany({
      where: {
        OR: [
          { blocker_id: viewerId, blocked_id: { in: ids } },
          { blocked_id: viewerId, blocker_id: { in: ids } },
        ],
      },
      select: { blocker_id: true, blocked_id: true },
    }),
    db.user.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } }),
  ])
  const friends = new Set(friendships.flatMap((f) => [f.user1_id, f.user2_id]))
  const asked = new Set(requests.filter((r) => r.sender_id === viewerId).map((r) => r.recipient_id))
  const askedMe = new Set(requests.filter((r) => r.recipient_id === viewerId).map((r) => r.sender_id))
  const blocked = new Set(blocks.flatMap((b) => [b.blocker_id, b.blocked_id]))
  const alive = new Set(live.map((u) => u.id))

  return new Map(
    conversations.map((c) => {
      const other = others.get(c.id)!
      if (!mayShowRealName(c, other)) return [c.id, NOTHING]
      const state: FriendOffer["state"] = friends.has(other) ? "friends" : asked.has(other) ? "requested" : askedMe.has(other) ? "incoming" : "none"
      const canAdd = addable(state) && isRevealedMatch(c) && alive.has(other) && !blocked.has(other)
      return [c.id, { state, canAdd }]
    })
  )
}

/**
 * The offer for one person on a profile. Call it only for somebody the viewer
 * may already see; it does not decide that.
 */
export async function friendOfferFor(viewerId: string, otherId: string): Promise<FriendOffer> {
  const [state, matched] = await Promise.all([friendState(viewerId, otherId), revealedMatch(viewerId, otherId)])
  if (state === "self") return NOTHING
  return { state, canAdd: addable(state) && matched }
}
