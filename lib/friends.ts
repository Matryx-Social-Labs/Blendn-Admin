import { randomBytes } from "crypto"
import { Prisma } from "@prisma/client"
import { logger } from "@/lib/logger"
import { db } from "@/lib/db"
import { conversationPair } from "@/lib/conversations"
import { sendPushNotification } from "@/lib/push-notifications"
import { UNNAMED, cameFromMatch, holdingPair, matchSelect, mayShowRealName } from "@/lib/conversation-identity"
import { dropCrewInvitesBetween } from "@/lib/crews/blocks"
import { notifyFriendshipChanged } from "@/lib/room-friends"
import { recordEndedFriendship } from "@/lib/room-people"

// They live in lib/conversation-identity.ts now: the socket server reaches lib/identity.ts, which may not import this file.
export { holdingPair, matchSelect }

/**
 * Friends: two people who both said yes.
 *
 * ## The two rules everything here serves
 *
 * **Nobody can be looked up.** There is no search, and nothing in this module
 * takes a name, a phone number, an email or a handle. A request reaches
 * somebody only through their invite link — which they chose to hand out — or
 * a match where both people have revealed (`revealedMatch`). Every refusal
 * a stranger could reach answers exactly like a link that never existed, and
 * costs the same work, so timing cannot tell them apart either.
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

/** Lives with `UNNAMED` now; the crew room names people by it too (`namesInRoom`). */
export { firstName } from "@/lib/conversation-identity"

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

export const eitherWay = (a: string, b: string) => ({
  OR: [
    { sender_id: a, recipient_id: b },
    { sender_id: b, recipient_id: a },
  ],
})

/**
 * Serialise everything that changes one pair's standing — an ask, an accept,
 * a block — for the length of the caller's transaction.
 *
 * Two people asking each other in the same instant would otherwise each miss
 * the other's uncommitted row and both wait forever; an accept racing a block
 * could write the friendship after the block had already cleared it, leaving a
 * blocked person on the blocker's list. A transaction-scoped advisory lock on
 * the canonical pair makes each of those happen one after the other.
 */
export async function lockPair(tx: Prisma.TransactionClient, a: string, b: string): Promise<void> {
  const [user1_id, user2_id] = conversationPair(a, b)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`friends:${user1_id}:${user2_id}`}, 0))`
}

/** What `pairIsLinked` reads: a transaction client, or `db`. */
type LinkReader = Pick<Prisma.TransactionClient, "friendships" | "private_conversations" | "friend_requests">

/**
 * Do these two people already have anything between them?
 *
 * True when ANY of these holds: a friendship; any conversation row, open OR
 * closed; any friend request, including a withdrawn or a dismissed one. The one
 * question every surface that would CREATE a link between two people asks first
 * — the mutual like, the board ask and accept — so they cannot drift apart:
 * a new link would hand back the old one (its id says which card is the friend)
 * or tie a second pseudonym to the first. A closed conversation counts because
 * leaving is permanent, and a withdrawn request because it is a record that they
 * met.
 *
 * Read it under the pair's lock (`lockPair`) when it decides a write, with the
 * transaction's client. Always three queries, whatever the answer.
 */
export async function pairIsLinked(client: LinkReader, a: string, b: string): Promise<boolean> {
  const [user1_id, user2_id] = conversationPair(a, b)
  const [friendship, conversation, request] = await Promise.all([
    client.friendships.findUnique({ where: { user1_id_user2_id: { user1_id, user2_id } }, select: { id: true } }),
    client.private_conversations.findUnique({ where: { user1_id_user2_id: { user1_id, user2_id } }, select: { id: true } }),
    client.friend_requests.findFirst({ where: eitherWay(a, b), select: { id: true } }),
  ])
  return friendship !== null || conversation !== null || request !== null
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
 * A withdrawn request is no request.
 */
export type FriendState = "self" | "friends" | "requested" | "incoming" | "none"

export async function friendState(viewerId: string, otherId: string): Promise<FriendState> {
  if (viewerId === otherId) return "self"
  const [friends, requests] = await Promise.all([
    areFriends(viewerId, otherId),
    db.friend_requests.findMany({
      where: { ...eitherWay(viewerId, otherId), withdrawn_at: null },
      select: { sender_id: true, held_at: true },
    }),
  ])
  if (friends) return "friends"
  if (requests.some((r) => r.sender_id === viewerId)) return "requested"
  // Theirs, held: the recipient is not told until the conversation is open and
  // both have revealed (a POSITIVE test: a closed one never releases).
  const [user1_id, user2_id] = conversationPair(viewerId, otherId)
  const released = requests.some((r) => r.held_at !== null)
    ? heldMayShow(await db.private_conversations.findUnique({ where: { user1_id_user2_id: { user1_id, user2_id } }, select: matchSelect }))
    : false
  if (requests.some((r) => r.held_at === null || released)) return "incoming"
  return "none"
}

/** What `readPair` needs: the transaction client or `db`. */
type PairReader = Pick<Prisma.TransactionClient, "user" | "blocked_users" | "private_conversations">

/**
 * The three facts every friend decision about a pair rests on, read together:
 * the other account is alive, nobody has blocked anybody, and the pair's
 * conversation (if any) is still open. Takes the client so a request can re-ask
 * it inside the pair's lock (`requestFriend`).
 *
 * **Always the same three queries**, whatever the answer — even for the
 * caller themselves, which is what a route passes when a link resolved to
 * nobody. A refusal that returned early would be faster than one that looked,
 * and "this link was reset" would be distinguishable by its timing from "the
 * person behind it blocked you".
 */
async function readPair(client: PairReader, askerId: string, otherId: string) {
  const [user1_id, user2_id] = conversationPair(askerId, otherId)
  const [other, blocked, conversation] = await Promise.all([
    client.user.findUnique({ where: { id: otherId, deletedAt: null }, select: { id: true } }),
    client.blocked_users.findFirst({
      where: {
        OR: [
          { blocker_id: askerId, blocked_id: otherId },
          { blocker_id: otherId, blocked_id: askerId },
        ],
      },
      select: { id: true },
    }),
    client.private_conversations.findUnique({
      where: { user1_id_user2_id: { user1_id, user2_id } },
      select: matchSelect,
    }),
  ])
  const connectable = askerId !== otherId && other !== null && blocked === null && conversation?.closed_at == null
  return { connectable, conversation }
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
  return (await readPair(db, askerId, otherId)).connectable
}

/**
 * `readPair(...).connectable` for many pairs at once, in three queries: both
 * accounts alive, no block either way, the pair's conversation (if any) not
 * closed. The batched form of the same rule, so a release of held requests
 * cannot disagree with the single-pair paths (`requestFriend`, `befriendIn`).
 * Returns the keys (`a|b`, the canonical pair order) of the pairs that may still
 * be connected.
 */
export async function connectablePairs(client: PairReader, pairs: readonly (readonly [string, string])[]): Promise<Set<string>> {
  if (pairs.length === 0) return new Set()
  const people = [...new Set(pairs.flat())]
  const [dead, blocks, conversations] = await Promise.all([
    client.user.findMany({ where: { id: { in: people }, deletedAt: { not: null } }, select: { id: true } }),
    client.blocked_users.findMany({
      where: { OR: pairs.map(([a, b]) => ({ OR: [{ blocker_id: a, blocked_id: b }, { blocker_id: b, blocked_id: a }] })) },
      select: { blocker_id: true, blocked_id: true },
    }),
    client.private_conversations.findMany({
      where: { closed_at: { not: null }, OR: pairs.map(([user1_id, user2_id]) => ({ user1_id, user2_id })) },
      select: { user1_id: true, user2_id: true },
    }),
  ])
  const gone = new Set(dead.map((u) => u.id))
  const blocked = new Set(blocks.map((b) => conversationPair(b.blocker_id, b.blocked_id).join("|")))
  const closed = new Set(conversations.map((c) => `${c.user1_id}|${c.user2_id}`))
  return new Set(
    pairs
      .map(([a, b]) => conversationPair(a, b))
      .filter(([a, b]) => !gone.has(a) && !gone.has(b) && !blocked.has(`${a}|${b}`) && !closed.has(`${a}|${b}`))
      .map((p) => p.join("|"))
  )
}

type MatchFacts = {
  user1_pseudonym: string | null
  user2_pseudonym: string | null
  user1_revealed: boolean
  user2_revealed: boolean
  origin_board_request_id: string | null
  closed_at: Date | null
}

/** An open conversation that came from a match: the pair that liked each other. */
const isOpenMatch = (c: MatchFacts) => c.closed_at === null && cameFromMatch(c)


/**
 * A held request may be shown to its recipient only on a positive test: the
 * pair's conversation is open AND both sides have revealed. Anything else — a
 * closed conversation above all, but also a missing one — keeps it hidden, so an
 * unmatch never releases what it was holding.
 */
export const heldMayShow = (c: (MatchFacts & { closed_at: Date | null }) | null | undefined): boolean =>
  !!c && c.closed_at === null && c.user1_revealed && c.user2_revealed

/**
 * The conversation half of `revealedMatch`. Pure, so the conversation list can
 * apply the same rule to rows it already holds without asking again.
 */
export const isRevealedMatch = (c: MatchFacts) => isOpenMatch(c) && c.user1_revealed && c.user2_revealed

/** Where a pair stands on the match rule, from the asker's side. */
export interface MatchStanding {
  /**
   * - `revealed`: an open match, both sides have shown their names, and nothing
   *   (a block, a deleted account, an unmatch) stands between them.
   * - `pending`: the same, but a side has not revealed yet.
   * - `none`: anything else.
   */
  standing: "revealed" | "pending" | "none"
  /**
   * The asker may already see who the other is: they revealed to them
   * (`mayShowRealName`). Only then is saying "you matched but not both
   * revealed" no news — for a pseudonym the asker cannot name, it would say who
   * the pseudonym is (an id found elsewhere, a friend's, a room handle).
   */
  askerSeesThem: boolean
}

/** Three queries, whatever the answer: see `readPair`. */
export async function matchStanding(askerId: string, otherId: string): Promise<MatchStanding> {
  const { connectable, conversation } = await readPair(db, askerId, otherId)
  if (!connectable || !conversation || !isOpenMatch(conversation)) return { standing: "none", askerSeesThem: false }
  return isRevealedMatch(conversation)
    ? { standing: "revealed", askerSeesThem: true }
    : { standing: "pending", askerSeesThem: mayShowRealName(conversation, otherId) }
}

/**
 * May `me` add `other` as a friend because they matched and both revealed?
 *
 * The owner's rule (2026-10-22): "if users have matched and they have revealed
 * themselves we can then give an option to add as friend." Nothing else lets a
 * request go by user id — not a room-level reveal, not `friends_see_me_in_rooms`,
 * not an accepted message request, which is not a match.
 */
export async function revealedMatch(me: string, other: string): Promise<boolean> {
  return (await matchStanding(me, other)).standing === "revealed"
}

/**
 * Ask to be friends. Idempotent, and it cannot nag.
 *
 * - Already friends: nothing to do.
 * - They had already asked you: that is both people saying yes, so it becomes
 *   a friendship now rather than two requests waiting on each other.
 * - Otherwise a request, **once**. Asking again — after a "Not now", or after
 *   withdrawing — finds the same row, notifies nobody, and leaves a "Not now"
 *   in place.
 *
 * How the asker found this person is the caller's to decide. Whether the pair
 * can still be connected (not blocked, not closed, not deleted — and for
 * `via: "match"`, still a match both revealed in) is asked again here under the
 * pair's lock, because an unmatch or a block between the caller's check and this
 * write would otherwise let the request through. `"refused"` is that answer.
 */
export async function requestFriend(
  senderId: string,
  recipientId: string,
  via?: "match"
): Promise<"friends" | "requested" | "refused"> {
  const outcome = await db.$transaction(async (tx) => {
    await lockPair(tx, senderId, recipientId)

    // The caller checked before taking the lock; an unmatch or a block holds the
    // same lock, so what it did is visible now and the answer can be re-asked.
    const { connectable, conversation } = await readPair(tx, senderId, recipientId)
    if (!connectable || (via === "match" && !(conversation && isRevealedMatch(conversation)))) {
      return { state: "refused" as const }
    }

    // A pair still pseudonymous to each other is not befriended yet: the
    // request is recorded and held, and delivered once both have revealed.
    const holding = holdingPair(conversation)

    const [friends, theirs, mine] = await Promise.all([
      tx.friendships.findUnique({ where: pairWhere(senderId, recipientId), select: { id: true } }),
      tx.friend_requests.findUnique({
        where: { sender_id_recipient_id: { sender_id: recipientId, recipient_id: senderId } },
        select: { withdrawn_at: true },
      }),
      tx.friend_requests.findUnique({
        where: { sender_id_recipient_id: { sender_id: senderId, recipient_id: recipientId } },
        select: { id: true, withdrawn_at: true, held_at: true },
      }),
    ])
    if (friends) return { state: "friends" as const }

    if (theirs && !theirs.withdrawn_at && !holding) {
      const made = await befriendIn(tx, senderId, recipientId)
      return made ? { state: "friends" as const, accepted: true } : { state: "requested" as const }
    }

    if (mine) {
      // Asking again after a withdrawal while the pair is still pseudonymous is
      // held too, like the first ask: a request that comes back must not be
      // delivered to somebody the asker is only a pseudonym to.
      const hold = holding && mine.held_at === null
      if (mine.withdrawn_at || hold) {
        await tx.friend_requests.update({
          where: { id: mine.id },
          data: { withdrawn_at: null, ...(hold && { held_at: new Date() }) },
        })
      }
      // Held once, and the reveal that releases it is what delivers it
      // (`releaseHeldRequests`); here it is simply still waiting.
      return { state: "requested" as const }
    }

    const created = await tx.friend_requests.create({
      data: { sender_id: senderId, recipient_id: recipientId, ...(holding && { held_at: new Date() }) },
      select: { id: true },
    })
    return holding ? { state: "requested" as const } : { state: "requested" as const, requestId: created.id }
  })

  // After the commit: a push is not a database write and cannot be rolled back.
  if ("requestId" in outcome && outcome.requestId) notifyFriendRequest(recipientId, outcome.requestId, via)
  if ("accepted" in outcome && outcome.accepted) {
    notifyFriendAccepted(recipientId)
    void notifyFriendshipChanged(senderId, recipientId)
  }
  return outcome.state
}

/**
 * Write the friendship and clear every request between the pair, inside the
 * caller's locked transaction — after checking, under that lock, that the pair
 * can still be connected (`readPair`: alive, not blocked, not closed). False
 * (and the requests cleared) if not.
 */
async function befriendIn(tx: Prisma.TransactionClient, a: string, b: string): Promise<boolean> {
  // The whole eligibility question, not only a block: an unmatch, a deleted
  // account or a block that landed after the accept's first check. Both an
  // accept and the auto-accept of a request that was waiting come through here.
  const { connectable, conversation } = await readPair(tx, a, b)
  // Still pseudonymous to each other: nothing is made, and nothing is cleared,
  // so the request waits for the reveal (`releaseHeldRequests`).
  if (connectable && holdingPair(conversation)) return false
  if (connectable) {
    const [user1_id, user2_id] = conversationPair(a, b)
    await tx.friendships.upsert({
      where: { user1_id_user2_id: { user1_id, user2_id } },
      create: { user1_id, user2_id },
      update: {},
    })
  }
  await tx.friend_requests.deleteMany({ where: eitherWay(a, b) })
  // Likes between them go inert for good (the owner's rule: friends are never
  // strangers): an unfriend later must not resurrect a match from an old like,
  // and a friend never counts toward anyone's "liked you" ranking.
  if (connectable) {
    // Friends again: nothing to keep apart any more.
    const [user1_id, user2_id] = conversationPair(a, b)
    await tx.ended_friendships.deleteMany({ where: { user1_id, user2_id } })
    await tx.event_likes.deleteMany({ where: { OR: [{ liker_id: a, liked_id: b }, { liker_id: b, liked_id: a }] } })
  }
  return connectable
}

/**
 * The recipient says yes. Returns false when the request is not theirs to
 * answer, is gone or withdrawn — the same answer either way.
 *
 * Under the pair's lock, so an accept and a block cannot interleave: whichever
 * takes the lock second sees the other's result.
 */
export async function acceptFriendRequest(requestId: string, recipientId: string): Promise<boolean> {
  const request = await db.friend_requests.findFirst({
    where: { id: requestId, recipient_id: recipientId, withdrawn_at: null },
    select: { sender_id: true },
  })
  if (!request) return false
  if (!(await mayConnect(recipientId, request.sender_id))) {
    await db.friend_requests.deleteMany({ where: { id: requestId } })
    return false
  }
  const made = await db.$transaction(async (tx) => {
    await lockPair(tx, recipientId, request.sender_id)
    const still = await tx.friend_requests.findFirst({
      where: { id: requestId, recipient_id: recipientId, withdrawn_at: null },
      select: { id: true },
    })
    return still ? befriendIn(tx, recipientId, request.sender_id) : false
  })
  if (made) {
    notifyFriendAccepted(request.sender_id)
    void notifyFriendshipChanged(recipientId, request.sender_id)
  }
  return made
}

/** At most this many held requests are looked at per release: a reveal never scans a table. */
const HELD_RELEASE_BATCH = 200

/**
 * Requests held for these people, released now that they may be: the pair's
 * conversation is open and both have revealed. Delivered at that moment — the
 * push goes out from here, not at the next read — and two people who had each
 * asked are made friends.
 *
 * One transaction for the whole batch, not one per pair: the pairs' locks are
 * taken in order (so two releases cannot deadlock), the conversations are read in
 * one query, and the held rows are cleared by one `UPDATE … RETURNING`. Only the
 * rows that statement actually cleared are announced, so two reveals landing at
 * once push exactly once.
 *
 * Called by the two writers of a reveal (`POST /conversations/:id/reveal`, and a
 * reveal in a room carrying into its DMs). A request this misses is still
 * delivered by reads (the requests list releases first; `friendState` tests it), only without the push.
 */
export async function releaseHeldRequests(userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return
  const ids = [...userIds]
  const held = await db.friend_requests.findMany({
    where: { held_at: { not: null }, withdrawn_at: null, OR: [{ sender_id: { in: ids } }, { recipient_id: { in: ids } }] },
    select: { sender_id: true, recipient_id: true },
    take: HELD_RELEASE_BATCH,
  })
  if (held.length === 0) return
  const pairs = [...new Map(held.map((r) => [conversationPair(r.sender_id, r.recipient_id).join("|"), conversationPair(r.sender_id, r.recipient_id)])).values()].sort(
    (x, y) => (x.join("|") < y.join("|") ? -1 : 1)
  )

  const outcome = await db.$transaction(async (tx) => {
    for (const [a, b] of pairs) await lockPair(tx, a, b)
    const conversations = await tx.private_conversations.findMany({
      where: { OR: pairs.map(([user1_id, user2_id]) => ({ user1_id, user2_id })) },
      select: matchSelect,
    })
    const open = new Set(conversations.filter(heldMayShow).map((c) => `${c.user1_id}|${c.user2_id}`))
    // Open and both revealed AND still connectable: a block or a deleted account
    // since the request was held keeps it held (and unreleased) for good.
    const alive = await connectablePairs(tx, pairs)
    const releasable = pairs.filter(([a, b]) => open.has(`${a}|${b}`) && alive.has(`${a}|${b}`))
    if (releasable.length === 0) return { requests: [], friends: [] as [string, string][] }

    const candidates = await tx.friend_requests.findMany({
      where: { held_at: { not: null }, withdrawn_at: null, OR: releasable.map(([a, b]) => eitherWay(a, b)) },
      select: { id: true },
    })
    if (candidates.length === 0) return { requests: [], friends: [] as [string, string][] }
    const released = await tx.$queryRaw<{ id: string; sender_id: string; recipient_id: string; dismissed_at: Date | null }[]>`
      UPDATE "friend_requests" SET "held_at" = NULL
      WHERE "held_at" IS NOT NULL AND "id" IN (${Prisma.join(candidates.map((c) => Prisma.sql`${c.id}::uuid`))})
      RETURNING "id", "sender_id", "recipient_id", "dismissed_at"`
    if (released.length === 0) return { requests: [], friends: [] as [string, string][] }

    // A pair with a live request each way — this one, and the one that was
    // waiting — is two people who both said yes.
    const releasedPairs = [...new Map(released.map((r) => [conversationPair(r.sender_id, r.recipient_id).join("|"), conversationPair(r.sender_id, r.recipient_id)])).values()]
    const live = await tx.friend_requests.findMany({
      where: { withdrawn_at: null, OR: releasedPairs.map(([a, b]) => eitherWay(a, b)) },
      select: { sender_id: true, recipient_id: true },
    })
    const senders = new Map<string, Set<string>>()
    for (const r of live) {
      const key = conversationPair(r.sender_id, r.recipient_id).join("|")
      senders.set(key, (senders.get(key) ?? new Set()).add(r.sender_id))
    }
    const mutual = releasedPairs.filter(([a, b]) => (senders.get(`${a}|${b}`)?.size ?? 0) > 1)
    if (mutual.length > 0) {
      await tx.friendships.createMany({ data: mutual.map(([user1_id, user2_id]) => ({ user1_id, user2_id })), skipDuplicates: true })
      // Likes between friends are inert for good (see `befriendIn`).
      await tx.event_likes.deleteMany({ where: { OR: mutual.flatMap(([a, b]) => [{ liker_id: a, liked_id: b }, { liker_id: b, liked_id: a }]) } })
      await tx.friend_requests.deleteMany({ where: { OR: mutual.map(([a, b]) => eitherWay(a, b)) } })
    }
    const mutualKeys = new Set(mutual.map((p) => p.join("|")))
    return {
      requests: released.filter((r) => !mutualKeys.has(conversationPair(r.sender_id, r.recipient_id).join("|"))),
      friends: mutual,
    }
  })

  // After the commit, and nothing here carries `via`: a held request may have
  // come by invite link, so "from your match" is not something to say.
  for (const [a, b] of outcome.friends) {
    notifyFriendAccepted(a)
    notifyFriendAccepted(b)
    void notifyFriendshipChanged(a, b)
  }
  for (const r of outcome.requests) if (!r.dismissed_at) notifyFriendRequest(r.recipient_id, r.id)
}

/**
 * "Not now." Hidden from the recipient's list and nowhere else — the sender
 * keeps seeing "Requested", because a decline delivered is a rejection.
 */
export async function dismissFriendRequest(requestId: string, recipientId: string): Promise<boolean> {
  const result = await db.friend_requests.updateMany({
    where: { id: requestId, recipient_id: recipientId, withdrawn_at: null },
    data: { dismissed_at: new Date() },
  })
  return result.count > 0
}

/**
 * The sender takes it back. Marked, not deleted: the row is what remembers that
 * this person was already notified once and may have been told "Not now".
 */
export async function withdrawFriendRequest(requestId: string, senderId: string): Promise<boolean> {
  const result = await db.friend_requests.updateMany({
    where: { id: requestId, sender_id: senderId, withdrawn_at: null },
    data: { withdrawn_at: new Date() },
  })
  return result.count > 0
}

/**
 * No longer friends. Silent — nobody is told — and it leaves any conversation
 * alone: unfriending is not blocking, and the DM is the pair's own record.
 * The crew invites between them go with it: an invite is a friend asking
 * (lib/crews/blocks.ts).
 */
export async function unfriend(a: string, b: string): Promise<void> {
  const [user1_id, user2_id] = conversationPair(a, b)
  await db.$transaction(async (tx) => {
    const { count } = await tx.friendships.deleteMany({ where: { user1_id, user2_id } })
    // Kept apart in every room for 24 h (B4): unfriending is silent, and the ex-friend's
    // stranger card must not appear at that moment. Only when there WAS a friendship.
    if (count > 0) await recordEndedFriendship(tx, a, b)
    await dropCrewInvitesBetween(tx, a, b)
  })
  // Each side's Friends here moves, for the events both are live in.
  void notifyFriendshipChanged(a, b)
}

/**
 * The friendship and any request between a pair, gone — for a block.
 *
 * Takes the block route's transaction client, which holds the pair's lock
 * (`lockPair`), so the block, the cancelled requests and this commit together
 * and no accept can slip in between: a block that left the friendship standing
 * would leave the blocked person on the blocker's friends list.
 */
export async function severFriendship(
  a: string,
  b: string,
  client: Pick<typeof db, "friendships" | "friend_requests" | "crew_invites">
): Promise<void> {
  const [user1_id, user2_id] = conversationPair(a, b)
  await client.friendships.deleteMany({ where: { user1_id, user2_id } })
  await client.friend_requests.deleteMany({ where: eitherWay(a, b) })
  // And any crew invite between them (C5): one friend asking the other.
  await dropCrewInvitesBetween(client, a, b)
}

/*
 * Pushes. Neither names anybody: both render on a lock screen other people can
 * see, and "who" is for the app, the same call `notifyMatch` makes.
 *
 * Fire-and-forget like every other sender, but logged: a broken push pipeline
 * must not be invisible.
 */
function notifyFriendRequest(recipientId: string, requestId: string, via?: "match"): void {
  sendPushNotification({
    userId: recipientId,
    title: "New friend request",
    body: "Someone wants to be friends. Open Blend’n to see who.",
    // `via` lets the app say "from your match". Never an event or a room.
    data: { type: "friend_request", requestId, ...(via && { via }) },
  }).catch((err: unknown) => logPushFailure("friend request", err))
}

function notifyFriendAccepted(recipientId: string): void {
  sendPushNotification({
    userId: recipientId,
    title: "Friend request accepted",
    body: "You’re friends now.",
    data: { type: "friend_accepted" },
  }).catch((err: unknown) => logPushFailure("friend accepted", err))
}

function logPushFailure(context: string, err: unknown): void {
  logger.warn("Push notification failed", { context, error: err instanceof Error ? err.message : String(err) })
}
