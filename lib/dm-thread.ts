import { db } from "@/lib/db"
import { VISIBLE_DM } from "@/lib/dm-moderation"
import { displayNameInConversation, type ConversationIdentity } from "@/lib/conversation-identity"
import { emitDelivered } from "@/lib/socket-server"

/**
 * Opening a DM thread's first page, as the reader sees it.
 *
 * Where the unread start is answered **before** anything is marked, so the app
 * can open there with an "Unread messages" divider (SCRUM-406). Then the whole
 * thread is read and delivered — not only the page: marking the newest 50 left
 * an older unread behind, and the Banter kept a dot on a thread you had just
 * opened. Delivery is told to the conversation so the sender's ✓ becomes ✓✓.
 *
 * Hidden messages are outside `VISIBLE_DM` and stay as they are: never shown,
 * never counted, never read.
 */
export async function openThread(
  conversationId: string,
  viewerId: string
): Promise<{ firstUnreadId: string | null; unreadCount: number }> {
  const incoming = { conversation_id: conversationId, sender_id: { not: viewerId }, ...VISIBLE_DM }
  const [first, unreadCount, undelivered] = await Promise.all([
    db.private_messages.findFirst({
      where: { ...incoming, is_read: false },
      orderBy: { created_at: "asc" },
      select: { id: true },
    }),
    db.private_messages.count({ where: { ...incoming, is_read: false } }),
    db.private_messages.findMany({ where: { ...incoming, delivered_at: null }, select: { id: true }, take: 500 }),
  ])

  if (unreadCount > 0) {
    // ponytail: one UPDATE for the whole backlog — fine at thousands of rows;
    // batch it if a thread's unread ever reaches the tens of thousands.
    await db.private_messages.updateMany({ where: { ...incoming, is_read: false }, data: { is_read: true } })
  }
  if (undelivered.length > 0) {
    const ids = undelivered.map((m) => m.id)
    await db.private_messages.updateMany({ where: { id: { in: ids } }, data: { delivered_at: new Date() } })
    emitDelivered(conversationId, ids)
  }
  return { firstUnreadId: first?.id ?? null, unreadCount }
}

/** What a reply quotes, loaded with the message. */
export const replyToSelect = {
  select: {
    id: true,
    sender_id: true,
    message_text: true,
    media_type: true,
    moderation_status: true,
    sender: { select: { name: true } },
  },
} as const

export interface ReplyQuote {
  id: string
  /** The quoted author as the reader knows them: a pseudonym until they reveal. */
  senderName: string
  text: string | null
  mediaType: string | null
  /** Hidden by moderation: the quote says so rather than showing it. */
  unavailable: boolean
}

const QUOTE_MAX = 140

export function quoteOf(
  conversation: ConversationIdentity,
  reply: {
    id: string
    sender_id: string
    message_text: string | null
    media_type: string | null
    moderation_status: string | null
    sender: { name: string | null }
  } | null
): ReplyQuote | null {
  if (!reply) return null
  const unavailable = reply.moderation_status === "hidden"
  const text = unavailable || !reply.message_text
    ? null
    : reply.message_text.length > QUOTE_MAX
      ? `${reply.message_text.slice(0, QUOTE_MAX - 1)}…`
      : reply.message_text
  return {
    id: reply.id,
    senderName: displayNameInConversation(conversation, reply.sender_id, reply.sender.name),
    text,
    mediaType: unavailable ? null : reply.media_type,
    unavailable,
  }
}

/**
 * Loading the inbox is the app having your messages: everything sent to you in
 * a live conversation is delivered — not read (SCRUM-408). Told per
 * conversation, so a sender with that thread open sees ✓✓.
 */
export async function markInboxDelivered(viewerId: string): Promise<void> {
  const rows = await db.private_messages.findMany({
    where: {
      sender_id: { not: viewerId },
      delivered_at: null,
      ...VISIBLE_DM,
      conversation: { closed_at: null, OR: [{ user1_id: viewerId }, { user2_id: viewerId }] },
    },
    select: { id: true, conversation_id: true },
    take: 500,
  })
  if (rows.length === 0) return
  await db.private_messages.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, delivered_at: null },
    data: { delivered_at: new Date() },
  })
  const byConversation = new Map<string, string[]>()
  for (const r of rows) byConversation.set(r.conversation_id, [...(byConversation.get(r.conversation_id) ?? []), r.id])
  for (const [conversationId, ids] of byConversation) emitDelivered(conversationId, ids)
}

