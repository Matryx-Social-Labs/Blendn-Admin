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

/** Find or create, always in canonical order. Safe against a concurrent create. */
export async function openConversation(a: string, b: string) {
  const [user1_id, user2_id] = conversationPair(a, b)
  return db.private_conversations.upsert({
    where: { user1_id_user2_id: { user1_id, user2_id } },
    create: { user1_id, user2_id },
    update: {},
  })
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
