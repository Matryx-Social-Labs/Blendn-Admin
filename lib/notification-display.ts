import { db } from "@/lib/db"
import { personCard, personSelect } from "@/lib/friends"
import { getAccessibleMediaUrl } from "@/lib/tigris"
import { firstName } from "@/lib/conversation-identity"

/**
 * What a bell row can say for the person reading it, beyond the push's own
 * nameless words (Flow 9 · 9.2, 9.3).
 *
 * The push is nameless on purpose: a lock screen is read by other people. The
 * bell is the reader's own screen, so a row may name and show somebody, but only
 * where the reader may already see them by the rule that screen is built on:
 *
 *   - a friend request: the asker, exactly as `GET /friends/requests` shows them
 *     to the same person, and only while the request is still waiting;
 *   - a match: the other side's room pseudonym, never a name or a photo;
 *   - a crew's or a Blend's emblem: a seed, no text of anyone's;
 *   - an event: its cover.
 *
 * Everything is optional and read defensively by the app. A row this cannot
 * resolve (the request is gone, the event deleted) gets nothing, and the app
 * draws the glyph tile for its kind. `open` is answered only for the kinds that
 * ask the reader something.
 *
 * Set-based: one query per kind for the whole page, never one per row.
 */

export type NotificationVisual =
  | { type: "photo"; uri: string }
  | { type: "creature"; pseudonym: string }
  | { type: "emblem"; seed: string }
  | { type: "event"; cover: string | null; badge: EventBadge; cancelled: boolean }

type EventBadge = "clock" | "map-pin" | "megaphone" | "star"

export interface RowDecoration {
  display?: { title?: string; context?: string; visual?: NotificationVisual }
  open?: boolean
}

interface Row {
  id: string
  kind: string
  payload: unknown
}

const EVENT_KINDS: Record<string, EventBadge> = {
  event_update: "clock",
  event_changed: "clock",
  announcement: "megaphone",
  waitlist_promoted: "star",
  rating_request: "star",
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const idOf = (payload: unknown, key: string): string | null => {
  const v = asRecord(payload)[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidOf = (payload: unknown, key: string) => {
  const v = idOf(payload, key)
  return v && UUID.test(v) ? v : null
}

const unique = <T>(xs: readonly (T | null)[]): T[] => [...new Set(xs.filter((x): x is T => x !== null))]

/** The decoration of each row by id, for the rows that have one. */
export async function decorateNotifications(viewerId: string, rows: readonly Row[]): Promise<Map<string, RowDecoration>> {
  const out = new Map<string, RowDecoration>()
  const set = (id: string, d: RowDecoration) => out.set(id, { ...out.get(id), ...d })
  const of = (kind: string) => rows.filter((r) => r.kind === kind)

  const friendRows = of("friend_request")
  const crewInviteRows = of("crew_invite")
  const messageRequestRows = of("message_request")
  const boardRows = of("board_request")
  const matchRows = of("match")
  const eventRows = rows.filter((r) => r.kind in EVENT_KINDS)

  const crewRows = rows.filter((r) => r.kind === "crew_invite" || r.kind === "crew_here")

  const [friendRequests, invites, memberships, messageRequests, boardRequests, conversations, events, crews] = await Promise.all([
    friendRows.length
      ? db.friend_requests.findMany({
          where: {
            id: { in: unique(friendRows.map((r) => uuidOf(r.payload, "requestId"))) },
            recipient_id: viewerId,
            dismissed_at: null,
            withdrawn_at: null,
            sender: { deletedAt: null },
          },
          select: { id: true, sender: { select: personSelect } },
        })
      : [],
    crewInviteRows.length
      ? db.crew_invites.findMany({
          where: {
            invited_user_id: viewerId,
            crew_id: { in: unique(crewInviteRows.map((r) => uuidOf(r.payload, "crewId"))) },
            declined_at: null,
            removed_at: null,
          },
          select: { crew_id: true },
        })
      : [],
    crewInviteRows.length
      ? db.crew_members.findMany({
          where: { user_id: viewerId, crew_id: { in: unique(crewInviteRows.map((r) => uuidOf(r.payload, "crewId"))) } },
          select: { crew_id: true },
        })
      : [],
    messageRequestRows.length
      ? db.message_requests.findMany({
          where: { id: { in: unique(messageRequestRows.map((r) => uuidOf(r.payload, "requestId"))) }, recipient_id: viewerId, status: "pending" },
          select: { id: true },
        })
      : [],
    boardRows.length
      ? db.board_requests.findMany({
          where: { id: { in: unique(boardRows.map((r) => uuidOf(r.payload, "requestId"))) }, to_user_id: viewerId, status: "pending" },
          select: { id: true },
        })
      : [],
    matchRows.length
      ? db.private_conversations.findMany({
          where: {
            id: { in: unique(matchRows.map((r) => uuidOf(r.payload, "conversationId"))) },
            OR: [{ user1_id: viewerId }, { user2_id: viewerId }],
          },
          select: { id: true, user1_id: true, user1_pseudonym: true, user2_pseudonym: true },
        })
      : [],
    eventRows.length
      // any-kind: a bell row names the event it was sent for, and a venue day's push is one the reader already got.
      ? db.events.findMany({
          where: { id: { in: unique(eventRows.map((r) => uuidOf(r.payload, "eventId"))) }, deleted_at: null },
          select: { id: true, cover_image_url: true, status: true },
        })
      : [],
    // The seed the crew's own screens draw its emblem from, so the bell draws the same one.
    crewRows.length
      ? db.crews.findMany({ where: { id: { in: unique(crewRows.map((r) => uuidOf(r.payload, "crewId"))) } }, select: { id: true, emblem_seed: true } })
      : [],
  ])
  const emblemOf = new Map(crews.map((c) => [c.id, c.emblem_seed]))

  const requestOf = new Map(friendRequests.map((r) => [r.id, r]))
  for (const row of friendRows) {
    const request = requestOf.get(uuidOf(row.payload, "requestId") ?? "")
    if (!request) {
      // Accepted (the row is deleted), dismissed, withdrawn or gone: nothing left to answer.
      set(row.id, { open: false })
      continue
    }
    const person = personCard(request.sender)
    set(row.id, {
      open: true,
      display: {
        title: `${firstName(person.name)} wants to be friends`,
        ...(person.photo && { visual: { type: "photo", uri: getAccessibleMediaUrl(person.photo) } }),
      },
    })
  }

  const invited = new Set(invites.map((i) => i.crew_id))
  const joined = new Set(memberships.map((m) => m.crew_id))
  for (const row of crewInviteRows) {
    const crewId = uuidOf(row.payload, "crewId")
    set(row.id, {
      open: crewId !== null && invited.has(crewId) && !joined.has(crewId),
      ...(crewId && emblemOf.has(crewId) && { display: { visual: { type: "emblem", seed: emblemOf.get(crewId)! } } }),
    })
  }
  for (const row of rows.filter((r) => r.kind === "crew_here" || r.kind === "blend")) {
    // A Blend has no emblem of its own: its id is a stable seed.
    const seed = row.kind === "blend" ? uuidOf(row.payload, "blendId") : emblemOf.get(uuidOf(row.payload, "crewId") ?? "")
    if (seed) set(row.id, { display: { visual: { type: "emblem", seed } } })
  }

  const pendingMessage = new Set(messageRequests.map((m) => m.id))
  for (const row of messageRequestRows) set(row.id, { open: pendingMessage.has(uuidOf(row.payload, "requestId") ?? "") })
  const pendingBoard = new Set(boardRequests.map((m) => m.id))
  for (const row of boardRows) set(row.id, { open: pendingBoard.has(uuidOf(row.payload, "requestId") ?? "") })

  const conversationOf = new Map(conversations.map((c) => [c.id, c]))
  for (const row of matchRows) {
    const c = conversationOf.get(uuidOf(row.payload, "conversationId") ?? "")
    // The other side's pseudonym. Null is a conversation that did not come from a match: no creature to draw.
    const pseudonym = c && (c.user1_id === viewerId ? c.user2_pseudonym : c.user1_pseudonym)
    if (pseudonym) set(row.id, { display: { visual: { type: "creature", pseudonym } } })
  }

  const eventOf = new Map(events.map((e) => [e.id, e]))
  for (const row of eventRows) {
    const event = eventOf.get(uuidOf(row.payload, "eventId") ?? "")
    if (!event) continue
    const reason = idOf(row.payload, "reason")
    const badge = reason === "venue" ? "map-pin" : EVENT_KINDS[row.kind]
    set(row.id, {
      display: {
        visual: {
          type: "event",
          cover: event.cover_image_url ? getAccessibleMediaUrl(event.cover_image_url) : null,
          badge,
          cancelled: event.status === "cancelled" || reason === "cancelled",
        },
      },
    })
  }

  return out
}
