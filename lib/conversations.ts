// Relative, not "@/lib/db" — see lib/live-snapshot.ts for why. Enforced by
// __tests__/server-import-boundary.test.ts.
import { db } from "./db"

/**
 * Opening a private conversation, in one place.
 *
 * There were two creation paths and they disagreed. `POST /conversations` sorted
 * the two ids before writing; the message-request accept handler wrote them in
 * request order (sender first). `private_conversations` has
 * `@@unique([user1_id, user2_id])`, so the same pair stored both ways produced
 * **two conversation rows for two people** — the constraint cannot see that
 * (a, b) and (b, a) are the same pair.
 *
 * Sorting is therefore not a detail of one handler. It is the only thing making
 * the unique constraint mean what it says, and it belongs where nobody has to
 * remember it.
 */
export function conversationPair(a: string, b: string): [string, string] {
  return [a, b].sort() as [string, string]
}

/** Thrown when a mutual like or accepted request lands on a closed pair. */
export class ConversationClosedError extends Error {
  constructor() {
    super("This conversation was closed and cannot be reopened")
    this.name = "ConversationClosedError"
  }
}

/**
 * Find or create, always in canonical order. Safe against a concurrent create.
 *
 * **Refuses a closed pair rather than returning it.** The upsert used
 * `update: {}`, which was correct while every row was live and silently wrong
 * the moment closing existed: a fresh mutual like or an accepted message
 * request would get the *closed* row back — a dead conversation that reads as
 * live to the caller, sits invisible in both inboxes, and refuses every message
 * sent to it. Unmatching is permanent (nothing rematches a pair), so the honest
 * answer here is an error, not a row.
 *
 * `ctx` is optional because only one of the three callers has an event.
 * `likeAtEvent` passes it; the message-request accept handler and
 * `POST /conversations` do not, and their conversations keep null pseudonyms —
 * which is what makes them show real names, as they always have.
 */
export async function openConversation(
  a: string,
  b: string,
  ctx?: {
    eventId?: string
    /** Room pseudonym per user id, snapshotted at creation. */
    pseudonyms?: Record<string, string | null>
    /** User ids already revealed in the originating room. */
    revealed?: readonly string[]
  }
) {
  const [user1_id, user2_id] = conversationPair(a, b)

  const existing = await db.private_conversations.findUnique({
    where: { user1_id_user2_id: { user1_id, user2_id } },
    select: { id: true, closed_at: true },
  })
  if (existing?.closed_at) throw new ConversationClosedError()
  if (existing) {
    /*
     * Deliberately not backfilled.
     *
     * A pair who already talked through a message request and *then* match at
     * an event keep the row they have: real names, no gating. They already know
     * each other, and retro-anonymising a live conversation would be absurd.
     */
    return db.private_conversations.findUniqueOrThrow({
      where: { user1_id_user2_id: { user1_id, user2_id } },
    })
  }

  const revealed = new Set(ctx?.revealed ?? [])
  return db.private_conversations.upsert({
    where: { user1_id_user2_id: { user1_id, user2_id } },
    create: {
      user1_id,
      user2_id,
      origin_event_id: ctx?.eventId ?? null,
      user1_pseudonym: ctx?.pseudonyms?.[user1_id] ?? null,
      user2_pseudonym: ctx?.pseudonyms?.[user2_id] ?? null,
      // Someone already public in the room has nothing left to reveal to a
      // person who saw their card. Seeding this true is what makes the
      // asymmetric case honest rather than theatre.
      user1_revealed: revealed.has(user1_id),
      user2_revealed: revealed.has(user2_id),
    },
    // Lost the create race: another request made the row a moment ago. Take it.
    update: {},
  })
}

/**
 * Close a conversation. Mutual, soft, and one-way.
 *
 * Mutual because a one-sided hide leaves the other person messaging into a
 * conversation you have left — no replies, but they can keep writing, which is
 * a harassment vector rather than a courtesy.
 *
 * Soft because the person most motivated to erase a conversation is the one
 * being reported in it. `message_reports.message_id` carries no foreign key, so
 * a hard delete leaves the report standing with its evidence gone and the admin
 * queue unable to resolve an author to suspend.
 *
 * Idempotent: closing twice keeps the first close, so a double tap or a retry
 * never rewrites who left or when.
 */
export async function closeConversation(
  conversationId: string,
  closedBy: string,
  reason: "unmatch" | "block"
) {
  return db.private_conversations.updateMany({
    where: { id: conversationId, closed_at: null },
    data: { closed_at: new Date(), closed_by: closedBy, closed_reason: reason },
  })
}

/**
 * Everyone this user has blocked, plus everyone who has blocked them.
 *
 * Blocks are symmetric in effect even though the row is directional: neither
 * person should see the other, whichever way round it was filed. Used to keep a
 * blocked person out of the room chat — the history, the live socket and the
 * push — which `blocked_users` had never been consulted for.
 */
export async function blockCounterparties(userId: string): Promise<string[]> {
  const rows = await db.blocked_users.findMany({
    where: { OR: [{ blocker_id: userId }, { blocked_id: userId }] },
    select: { blocker_id: true, blocked_id: true },
  })
  return [...new Set(rows.map((r) => (r.blocker_id === userId ? r.blocked_id : r.blocker_id)))]
}

/** Did these two leave each other? Checked in both directions, like a block. */
export async function pairIsClosed(a: string, b: string): Promise<boolean> {
  const [user1_id, user2_id] = conversationPair(a, b)
  const row = await db.private_conversations.findUnique({
    where: { user1_id_user2_id: { user1_id, user2_id } },
    select: { closed_at: true },
  })
  return row?.closed_at != null
}

/** The other user in every closed pair involving this user. */
export async function closedPairKeys(userId: string): Promise<Set<string>> {
  const rows = await db.private_conversations.findMany({
    where: {
      closed_at: { not: null },
      OR: [{ user1_id: userId }, { user2_id: userId }],
    },
    select: { user1_id: true, user2_id: true },
  })
  return new Set(rows.map((r) => (r.user1_id === userId ? r.user2_id : r.user1_id)))
}

/**
 * Has either side blocked the other?
 *
 * Checked in both directions. `blocked_users` is directional, and a block is
 * meant to stop the conversation, not just one person's half of it — the
 * existing DM send path only looked one way, so someone you had blocked could
 * still be messaged by you, which is not what "block" means to either party.
 */
export async function blockedEitherWay(a: string, b: string): Promise<boolean> {
  const row = await db.blocked_users.findFirst({
    where: {
      OR: [
        { blocker_id: a, blocked_id: b },
        { blocker_id: b, blocked_id: a },
      ],
    },
    select: { id: true },
  })
  return row !== null
}

/**
 * May these two hold a private conversation?
 *
 * DMs are gated behind a message request the other person accepted — that is the
 * product's stated guarantee, and the whole reason the room is pseudonymous.
 * `POST /conversations` bypassed it completely: it created a conversation from
 * nothing but two user ids, so the gate existed only on the screen that happened
 * to use it.
 *
 * An already-open conversation counts, so this stays true for pairs who
 * connected before the check existed.
 */
export async function mayConverse(a: string, b: string): Promise<boolean> {
  const [user1_id, user2_id] = conversationPair(a, b)
  const [accepted, existing] = await Promise.all([
    db.message_requests.findFirst({
      where: {
        status: "accepted",
        OR: [
          { sender_id: a, recipient_id: b },
          { sender_id: b, recipient_id: a },
        ],
      },
      select: { id: true },
    }),
    db.private_conversations.findUnique({
      where: { user1_id_user2_id: { user1_id, user2_id } },
      select: { id: true },
    }),
  ])
  return accepted !== null || existing !== null
}

/**
 * Have these two ever been in the same room?
 *
 * Message requests had no such test: any authenticated caller could request any
 * user id, which makes the whole product a directory of strangers rather than a
 * way to talk to people you met somewhere.
 *
 * **Ever, not right now.** Requiring current co-presence would be tighter and
 * wrong — the most ordinary use of this feature is thinking better of it on the
 * way home and messaging someone the next morning. The room is where you earn
 * the right to ask; it does not expire when you leave it.
 *
 * `check_in_time: not null` matters: an RSVP is not attendance, and someone who
 * merely intended to come was never in the room with anyone.
 */
export async function haveSharedAnEvent(a: string, b: string): Promise<boolean> {
  const mine = await db.event_check_ins.findMany({
    where: { user_id: a, check_in_time: { not: null } },
    select: { event_id: true },
    distinct: ["event_id"],
  })
  if (mine.length === 0) return false

  const overlap = await db.event_check_ins.findFirst({
    where: {
      user_id: b,
      check_in_time: { not: null },
      event_id: { in: mine.map((m) => m.event_id) },
    },
    select: { id: true },
  })
  return overlap !== null
}
