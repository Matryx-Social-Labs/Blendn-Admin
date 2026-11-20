import type { Prisma } from "@prisma/client"

import { boardPseudonyms } from "@/lib/board-access"
import { db } from "@/lib/db"
import { metInFor, metInSelect } from "@/lib/met-in"
import { openRoomHandle } from "@/lib/room-handle"

/**
 * What a blocker was shown for the person they blocked, and where — kept on the
 * block (`blocked_users.seen_as` / `seen_in`) so the blocked list can tell one
 * "Someone" from another (SCRUM-1082). Both are things the blocker already saw:
 * a pseudonym (never a real name) and a place's name as a page shows it
 * (`metInFor`: an event's title, a venue day's venue; null for a draft or a
 * deleted event). Null for anything not known.
 */
export interface BlockSeen {
  seenAs: string | null
  seenIn: string | null
}

export const SEEN_NOTHING: BlockSeen = { seenAs: null, seenIn: null }

type Client = Prisma.TransactionClient | typeof db

async function placeOf(client: Client, eventId: string | null): Promise<string | null> {
  if (!eventId) return null
  return metInFor(await client.events.findUnique({ where: { id: eventId }, select: metInSelect }))?.name ?? null
}

/** A match's: the pseudonym the conversation snapshotted for them, and the room it came from. */
export async function conversationSeen(client: Client, conversationId: string, otherId: string): Promise<BlockSeen> {
  const c = await client.private_conversations.findUnique({
    where: { id: conversationId },
    select: { user1_id: true, user1_pseudonym: true, user2_pseudonym: true, origin_event_id: true },
  })
  if (!c) return SEEN_NOTHING
  return { seenAs: (c.user1_id === otherId ? c.user1_pseudonym : c.user2_pseudonym) ?? null, seenIn: await placeOf(client, c.origin_event_id) }
}

/** A message request's: where the two met. A request shows its sender's name, so there is no pseudonym to keep. */
export async function requestSeen(metInEventId: string | null): Promise<BlockSeen> {
  return { seenAs: null, seenIn: await placeOf(db, metInEventId) }
}

/**
 * From the ref a block came by (`POST /users/:ref/block`), already resolved to
 * `targetId`. A raw id says nothing. An event's handle: their pseudonym there
 * (the room's, or the board's before doors) and the event. A conversation's:
 * `conversationSeen`. Another room's (a crew, a Blend, a post's room): their
 * name in it when it gave them one, and the room's name.
 */
export async function blockSeenFromRef(ref: string, targetId: string): Promise<BlockSeen> {
  const opened = openRoomHandle(ref)
  if (!opened || opened.userId !== targetId) return SEEN_NOTHING
  const { scope } = opened
  if (typeof scope === "string") {
    const [names, seenIn] = await Promise.all([boardPseudonyms(scope, [targetId]), placeOf(db, scope)])
    return { seenAs: names.get(targetId) ?? null, seenIn }
  }
  if (scope.kind === "dm") return conversationSeen(db, scope.groupId, targetId)
  const room = await db.chat_groups.findUnique({
    where: { id: scope.groupId },
    select: { name: true, members: { where: { user_id: targetId }, select: { anonymous_name: true } } },
  })
  return { seenAs: room?.members[0]?.anonymous_name ?? null, seenIn: room?.name ?? null }
}
