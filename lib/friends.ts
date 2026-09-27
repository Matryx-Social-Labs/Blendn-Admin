import { randomBytes } from "crypto"
import { logger } from "@/lib/logger"
import { db } from "@/lib/db"
import { blockedEitherWay, conversationPair, pairIsClosed } from "@/lib/conversations"
import { sendPushNotification } from "@/lib/push-notifications"
import { UNNAMED } from "@/lib/conversation-identity"

/**
 * Friends: two people who both said yes.
 *
 * ## The two rules everything here serves
 *
 * **Nobody can be looked up.** There is no search, and nothing in this module
 * takes a name, a phone number, an email or a handle. A request reaches
 * somebody only through their invite link — which they chose to hand out — or
 * a person the asker can already see under `maySeeIdentityFor`. Every refusal
 * a stranger could reach answers exactly like a link that never existed.
 *
 * **Friends are still pseudonyms in a room.** Friendship is deliberately not a
 * branch of `maySeeIdentityFor` unless the person turned on
 * `profiles.friends_see_me_in_rooms`, and a DM between friends is marked
 * `origin_friendship` so it does not open that gate through the back. Friend
 * surfaces — the list, a friend's profile — show real names because both people
 * agreed; a room is somewhere else, with other people in it.
 */

/**
 * Where invite links point.
 *
 * `www`, not the apex: `blendn.app` answers with a 307 to `www.blendn.app`, and
 * both Apple and Google refuse an association file served behind a redirect —
 * so an apex link would never open the app.
 */
export const INVITE_LINK_BASE = "https://www.blendn.app/f/"

/**
 * A person as the friend surfaces show them: a name and one photo.
 *
 * Only ever built for someone the caller is entitled to see — a friend, a
 * requester who asked them, or the owner of a link they were given. There is
 * no pseudonym here because none of those is a room.
 */
export const personSelect = {
  id: true,
  name: true,
  image: true,
  profile: { select: { name: true, photos: true } },
} as const

export function personCard(user: {
  id: string
  name: string | null
  image: string | null
  profile: { name: string | null; photos: string[] } | null
}) {
  return {
    userId: user.id,
    name: user.profile?.name || user.name || UNNAMED,
    photo: user.profile?.photos?.[0] ?? user.image ?? null,
  }
}

/** 16 random bytes, base64url: 22 characters, 128 bits. Not guessable, not enumerable. */
export function newInviteToken(): string {
  return randomBytes(16).toString("base64url")
}

/** The shape `newInviteToken` produces. Anything else is refused before a query. */
export const INVITE_TOKEN = /^[A-Za-z0-9_-]{22}$/

export function inviteUrl(token: string): string {
  return `${INVITE_LINK_BASE}${token}`
}

/** This person's link, created on first ask. One per person. */
export async function inviteTokenFor(userId: string): Promise<string> {
  const existing = await db.friend_invites.findUnique({ where: { user_id: userId }, select: { token: true } })
  if (existing) return existing.token
  const row = await db.friend_invites.upsert({
    where: { user_id: userId },
    create: { user_id: userId, token: newInviteToken() },
    // Lost a create race: the other request's token is as good as ours.
    update: {},
    select: { token: true },
  })
  return row.token
}

/** A new link. The old one then answers exactly as a link that never existed. */
export async function resetInviteToken(userId: string): Promise<string> {
  const token = newInviteToken()
  await db.friend_invites.upsert({
    where: { user_id: userId },
    create: { user_id: userId, token },
    update: { token, created_at: new Date() },
  })
  return token
}

function pairWhere(a: string, b: string) {
  const [user1_id, user2_id] = conversationPair(a, b)
  return { user1_id_user2_id: { user1_id, user2_id } }
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  if (a === b) return false
  const row = await db.friendships.findUnique({ where: pairWhere(a, b), select: { id: true } })
  return row !== null
}

/** Everyone this person is friends with. */
export async function friendIdsOf(userId: string): Promise<string[]> {
  const rows = await db.friendships.findMany({
    where: { OR: [{ user1_id: userId }, { user2_id: userId }] },
    select: { user1_id: true, user2_id: true },
  })
  return rows.map((r) => (r.user1_id === userId ? r.user2_id : r.user1_id))
}

/**
 * Where two people stand, from `viewerId`'s side.
 *
 * `incoming` is shown even when the viewer dismissed it: they are looking at
 * the person now, and accepting from here is the obvious thing to offer.
 * `requested` never says whether it was dismissed — the asker is not told.
 */
export type FriendState = "self" | "friends" | "requested" | "incoming" | "none"

export async function friendState(viewerId: string, otherId: string): Promise<FriendState> {
  if (viewerId === otherId) return "self"
  const [friends, requests] = await Promise.all([
    areFriends(viewerId, otherId),
    db.friend_requests.findMany({
      where: {
        OR: [
          { sender_id: viewerId, recipient_id: otherId },
          { sender_id: otherId, recipient_id: viewerId },
        ],
      },
      select: { sender_id: true },
    }),
  ])
  if (friends) return "friends"
  if (requests.some((r) => r.sender_id === viewerId)) return "requested"
  if (requests.length > 0) return "incoming"
  return "none"
}

/**
 * Could `askerId` be connected to `otherId` at all?
 *
 * False for anything a stranger must not be able to tell apart from a link
 * that does not exist: a deleted account, a block in either direction, or a
 * pair who left each other (unmatch is permanent, as it is for message
 * requests). Callers answer all of them with the same 404.
 */
export async function mayConnect(askerId: string, otherId: string): Promise<boolean> {
  if (askerId === otherId) return false
  const [other, blocked, closed] = await Promise.all([
    db.user.findUnique({ where: { id: otherId, deletedAt: null }, select: { id: true } }),
    blockedEitherWay(askerId, otherId),
    pairIsClosed(askerId, otherId),
  ])
  return other !== null && !blocked && !closed
}

/**
 * Ask to be friends. Idempotent, and it cannot nag.
 *
 * - Already friends: nothing to do.
 * - They had already asked you: that is both people saying yes, so it becomes
 *   a friendship now rather than two requests waiting on each other.
 * - Otherwise a request, **once**. Asking again finds the same row and neither
 *   notifies again nor un-dismisses a "Not now".
 *
 * Eligibility (`mayConnect`, and how the asker found this person) is the
 * caller's; this only records the answer.
 */
export async function requestFriend(senderId: string, recipientId: string): Promise<"friends" | "requested"> {
  if (await areFriends(senderId, recipientId)) return "friends"

  const theirs = await db.friend_requests.findUnique({
    where: { sender_id_recipient_id: { sender_id: recipientId, recipient_id: senderId } },
    select: { id: true },
  })
  if (theirs) {
    await befriend(senderId, recipientId)
    notifyFriendAccepted(recipientId)
    return "friends"
  }

  const existing = await db.friend_requests.findUnique({
    where: { sender_id_recipient_id: { sender_id: senderId, recipient_id: recipientId } },
    select: { id: true },
  })
  if (existing) return "requested"

  const created = await db.friend_requests.upsert({
    where: { sender_id_recipient_id: { sender_id: senderId, recipient_id: recipientId } },
    create: { sender_id: senderId, recipient_id: recipientId },
    // A concurrent ask won the race; theirs is ours.
    update: {},
    select: { id: true },
  })
  notifyFriendRequest(recipientId, created.id)
  return "requested"
}

/**
 * Write the friendship and clear every request between the pair, atomically.
 * Both directions, because a mutual ask leaves one row each way.
 */
async function befriend(a: string, b: string): Promise<void> {
  const [user1_id, user2_id] = conversationPair(a, b)
  await db.$transaction([
    db.friendships.upsert({
      where: { user1_id_user2_id: { user1_id, user2_id } },
      create: { user1_id, user2_id },
      update: {},
    }),
    db.friend_requests.deleteMany({
      where: {
        OR: [
          { sender_id: a, recipient_id: b },
          { sender_id: b, recipient_id: a },
        ],
      },
    }),
  ])
}

/**
 * The recipient says yes. Returns false when the request is not theirs to
 * answer, or is gone — the same answer either way.
 *
 * Re-checks `mayConnect`: a block filed after the request was sent deletes it
 * (see the block route), but a request answered in the same instant must not
 * become a friendship between two people who have just blocked each other.
 */
export async function acceptFriendRequest(requestId: string, recipientId: string): Promise<boolean> {
  const request = await db.friend_requests.findFirst({
    where: { id: requestId, recipient_id: recipientId },
    select: { sender_id: true },
  })
  if (!request) return false
  if (!(await mayConnect(recipientId, request.sender_id))) {
    await db.friend_requests.deleteMany({ where: { id: requestId } })
    return false
  }
  await befriend(recipientId, request.sender_id)
  notifyFriendAccepted(request.sender_id)
  return true
}

/**
 * "Not now." Hidden from the recipient's list and nowhere else — the sender
 * keeps seeing "Requested", because a decline delivered is a rejection.
 */
export async function dismissFriendRequest(requestId: string, recipientId: string): Promise<boolean> {
  const result = await db.friend_requests.updateMany({
    where: { id: requestId, recipient_id: recipientId },
    data: { dismissed_at: new Date() },
  })
  return result.count > 0
}

/** The sender takes it back. */
export async function withdrawFriendRequest(requestId: string, senderId: string): Promise<boolean> {
  const result = await db.friend_requests.deleteMany({ where: { id: requestId, sender_id: senderId } })
  return result.count > 0
}

/**
 * No longer friends. Silent — nobody is told — and it leaves any conversation
 * alone: unfriending is not blocking, and the DM is the pair's own record.
 */
export async function unfriend(a: string, b: string): Promise<void> {
  const [user1_id, user2_id] = conversationPair(a, b)
  await db.friendships.deleteMany({ where: { user1_id, user2_id } })
}

/**
 * The friendship and any request between a pair, gone — for a block.
 *
 * Takes the block route's transaction client so the block, the cancelled
 * requests and this commit together: a block that left the friendship
 * standing would leave the blocked person on the blocker's friends list, able
 * to open a DM from it.
 */
export async function severFriendship(
  a: string,
  b: string,
  client: Pick<typeof db, "friendships" | "friend_requests">
): Promise<void> {
  const [user1_id, user2_id] = conversationPair(a, b)
  await client.friendships.deleteMany({ where: { user1_id, user2_id } })
  await client.friend_requests.deleteMany({
    where: {
      OR: [
        { sender_id: a, recipient_id: b },
        { sender_id: b, recipient_id: a },
      ],
    },
  })
}

/*
 * Pushes. Neither names anybody: both render on a lock screen other people can
 * see, and "who" is for the app, the same call `notifyMatch` makes.
 *
 * Fire-and-forget like every other sender, but logged: a broken push pipeline
 * must not be invisible.
 */
function notifyFriendRequest(recipientId: string, requestId: string): void {
  sendPushNotification({
    userId: recipientId,
    title: "New friend request",
    body: "Someone wants to be friends. Open Blendn to see who.",
    data: { type: "friend_request", requestId },
    channelId: "messages",
  }).catch((err: unknown) => logPushFailure("friend request", err))
}

function notifyFriendAccepted(recipientId: string): void {
  sendPushNotification({
    userId: recipientId,
    title: "Friend request accepted",
    body: "You're friends now.",
    data: { type: "friend_accepted" },
    channelId: "messages",
  }).catch((err: unknown) => logPushFailure("friend accepted", err))
}

function logPushFailure(context: string, err: unknown): void {
  logger.warn("Push notification failed", { context, error: err instanceof Error ? err.message : String(err) })
}
