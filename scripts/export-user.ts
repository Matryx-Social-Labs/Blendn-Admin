import { Prisma, PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

/**
 * One person's own data, as one JSON document on stdout (SCRUM-1249).
 *
 *   DATABASE_URL=... npx tsx scripts/export-user.ts <email|userId> > export.json
 *
 * The answer to "Get a copy of your data" (the app opens an email to support).
 *
 * RUNBOOK
 * - Answer only a request sent FROM the account's own address, and send the
 *   file only TO that address. A request from any other address gets a reply
 *   asking them to write from the address on the account; nothing else.
 * - Who runs it: platform staff (an `app_admin` on a company address), never a
 *   host or a contractor. Against production only with `--allow-remote` and
 *   production's DATABASE_PUBLIC_URL in the environment of that one command;
 *   without the flag it refuses any database that is not on this machine.
 * - It writes nothing: every read runs in one READ ONLY, repeatable-read
 *   transaction, so the database itself refuses a write and the document is
 *   one consistent moment.
 * - Delete the file from your machine once it is sent. Record the request (date
 *   asked, date answered, never the contents) on the privacy ticket in Jira.
 * - How long we have to answer: the response timelines are the legal Epic's
 *   (SCRUM-1122), not this file's.
 *
 * WHAT IS IN IT
 * - The person's account, profile, check-ins (coordinates as stored), RSVPs,
 *   favourites, ratings, the messages they wrote, reports they filed, crews,
 *   friends, waves and the rest of `EXPORT_CHECKLIST`.
 * - Anybody else appears only as `person-N` (an opaque reference, the same
 *   person the same N throughout one document, meaningless outside it) or as
 *   the pseudonym the product showed. Never an email, phone, name or user id.
 * - Words other people wrote are withheld: the other side of a DM, other
 *   people's room messages, a report's excerpt, a request someone sent them.
 *   They are that person's personal data as much as this one's, free text can
 *   carry a name or a number no pseudonym strips, and a copy sent cannot be
 *   recalled (Fable advisor pick, 2026-11-26). Threads and rooms carry counts.
 *   A request for a transcript goes to the privacy contact, not this script.
 *
 * `EXPORT_CHECKLIST` names every table the account erasure (DELETE
 * /api/mobile/account) touches, so the two stay in step:
 * `__tests__/export-user.test.ts` fails on a table the
 * erasure learns about and this file does not.
 */

/** Table → the document key it is exported under, or "not exported: <why>". */
export const EXPORT_CHECKLIST: Record<string, string> = {
  user: "account",
  profiles: "profile",
  user_interests: "interests",
  this_or_that_answers: "this_or_that",
  user_oauth_accounts: "sign_in_links",
  event_check_ins: "check_ins",
  presence_sessions: "presence",
  event_rsvps: "rsvps",
  event_favorites: "favorites",
  event_ratings: "ratings",
  event_reports: "event_reports_filed",
  event_match_preferences: "match_preferences",
  chat_groups: "room_memberships",
  chat_group_members: "room_memberships",
  chat_messages: "room_messages",
  private_conversations: "dm_threads",
  private_messages: "dm_messages",
  message_requests: "message_requests",
  message_reports: "message_reports_filed",
  user_reports: "user_reports_filed",
  blocked_users: "blocks",
  friendships: "friends",
  friend_requests: "friend_requests",
  referrals: "referral",
  event_waves: "waves",
  event_likes: "likes_sent",
  crews: "crews",
  crew_members: "crews",
  crew_invites: "crew_invites",
  crew_hides: "crew_hides",
  blend_reveals: "blend_reveals",
  board_posts: "board_posts",
  board_requests: "board_requests",
  board_alert_preferences: "board_alerts",
  notifications: "notifications",
  product_events: "product_events",
  photo_checks: "photo_checks",
  city_demand: "city_demand",
  market_previewers: "market_previews",
  venue_regular_optins: "venue_regulars",
  venue_offer_mutes: "venue_offer_mutes",
  venue_offer_sends: "venue_offers_received",
  friend_invites: "not exported: the invite link's token is a credential",
  crew_invite_tokens: "not exported: crew link tokens are credentials",
  mobile_refresh_tokens: "not exported: sign-in credentials",
  push_tokens: "not exported: device push credentials",
  password_reset_tokens: "not exported: sign-in credentials",
  account: "not exported: dashboard OAuth credentials",
  session: "not exported: dashboard session credentials",
}

const WITHHELD =
  "Messages and requests written by other people are withheld as their personal information; other people appear as person-N or a pseudonym."

// ponytail: one transaction holds every read; a person with very many rows (product_events) is what raises this.
const EXPORT_TIMEOUT_MS = 120_000

type Tx = Prisma.TransactionClient

/** The person's data. Reads only, inside a READ ONLY transaction. */
export async function exportUser(db: PrismaClient, userId: string): Promise<Record<string, unknown>> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      return collect(tx, userId)
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: EXPORT_TIMEOUT_MS }
  )
}

async function collect(tx: Tx, id: string): Promise<Record<string, unknown>> {
  const refs = new Map<string, string>()
  const person = (otherId: string) => {
    if (!refs.has(otherId)) refs.set(otherId, `person-${refs.size + 1}`)
    return refs.get(otherId)!
  }
  const mine = { where: { user_id: id } }
  const oldestFirst = { orderBy: { created_at: "asc" as const } }

  const account = await tx.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, emailVerified: true, image: true, role: true, createdAt: true, deletedAt: true, suspended_at: true },
  })
  if (!account) throw new Error(`No account ${id}`)

  const memberships = await tx.chat_group_members.findMany({
    ...mine,
    ...oldestFirst,
    select: {
      chat_group_id: true,
      anonymous_name: true,
      role: true,
      status: true,
      joined_at: true,
      left_at: true,
      banned_at: true,
      muted_at: true,
      chat_group: { select: { name: true, kind: true, event_id: true } },
    },
  })
  const roomIds = memberships.map((m) => m.chat_group_id)
  const othersInRooms = await tx.chat_messages.groupBy({
    by: ["chat_group_id"],
    where: { chat_group_id: { in: roomIds }, user_id: { not: id } },
    _count: { _all: true },
  })

  const threads = await tx.private_conversations.findMany({
    where: { OR: [{ user1_id: id }, { user2_id: id }] },
    ...oldestFirst,
  })
  const othersInThreads = await tx.private_messages.groupBy({
    by: ["conversation_id"],
    where: { conversation_id: { in: threads.map((t) => t.id) }, sender_id: { not: id } },
    _count: { _all: true },
  })

  const friendships = await tx.friendships.findMany({ where: { OR: [{ user1_id: id }, { user2_id: id }] }, ...oldestFirst })
  const friendRequests = await tx.friend_requests.findMany({ where: { OR: [{ sender_id: id }, { recipient_id: id }] }, ...oldestFirst })
  const waves = await tx.event_waves.findMany({ where: { OR: [{ from_id: id }, { to_id: id }] }, ...oldestFirst })
  const messageRequests = await tx.message_requests.findMany({ where: { OR: [{ sender_id: id }, { recipient_id: id }] }, ...oldestFirst })
  const referral = await tx.referrals.findUnique({ where: { invitee_id: id }, select: { inviter_id: true, created_at: true } })
  const crewInvites = await tx.crew_invites.findMany({ where: { OR: [{ invited_user_id: id }, { invited_by: id }] }, ...oldestFirst })
  const boardRequests = await tx.board_requests.findMany({ where: { OR: [{ from_user_id: id }, { to_user_id: id }] }, ...oldestFirst })

  return {
    note: WITHHELD,
    generated_at: new Date().toISOString(),
    account,
    profile: await tx.profiles.findUnique({ where: { id } }),
    interests: (await tx.user_interests.findMany({ ...mine, ...oldestFirst, select: { category: { select: { name: true } } } })).map((i) => i.category.name),
    this_or_that: await tx.this_or_that_answers.findMany({ ...mine, select: { question: true, choice: true, answered_at: true } }),
    sign_in_links: await tx.user_oauth_accounts.findMany({ ...mine, select: { provider: true, email: true, created_at: true } }),
    check_ins: await tx.event_check_ins.findMany({ ...mine, ...oldestFirst, omit: { user_id: true }, include: { event: { select: { title: true } } } }),
    presence: await tx.presence_sessions.findMany({ ...mine, ...oldestFirst, omit: { user_id: true } }),
    rsvps: await tx.event_rsvps.findMany({ ...mine, ...oldestFirst, omit: { user_id: true }, include: { event: { select: { title: true } } } }),
    favorites: await tx.event_favorites.findMany({ ...mine, ...oldestFirst, select: { event_id: true, created_at: true } }),
    ratings: await tx.event_ratings.findMany({ ...mine, ...oldestFirst, select: { event_id: true, rating: true, created_at: true } }),
    event_reports_filed: await tx.event_reports.findMany({
      ...mine,
      ...oldestFirst,
      select: { event_id: true, reason: true, description: true, status: true, created_at: true },
    }),
    match_preferences: await tx.event_match_preferences.findMany({ ...mine, ...oldestFirst, omit: { user_id: true } }),
    room_memberships: memberships.map(({ chat_group, anonymous_name, ...m }) => ({
      ...m,
      room_name: chat_group.name,
      room_kind: chat_group.kind,
      event_id: chat_group.event_id,
      my_pseudonym: anonymous_name,
      messages_by_others: othersInRooms.find((g) => g.chat_group_id === m.chat_group_id)?._count._all ?? 0,
    })),
    room_messages: await tx.chat_messages.findMany({
      ...mine,
      ...oldestFirst,
      select: { chat_group_id: true, type: true, content: true, created_at: true, edited_at: true, deleted_at: true, moderation_status: true },
    }),
    dm_threads: threads.map((t) => {
      const iAmOne = t.user1_id === id
      return {
        conversation_id: t.id,
        counterpart: person(iAmOne ? t.user2_id : t.user1_id),
        counterpart_pseudonym: iAmOne ? t.user2_pseudonym : t.user1_pseudonym,
        my_pseudonym: iAmOne ? t.user1_pseudonym : t.user2_pseudonym,
        i_revealed: iAmOne ? t.user1_revealed : t.user2_revealed,
        created_at: t.created_at,
        closed_at: t.closed_at,
        closed_reason: t.closed_reason,
        messages_by_counterpart: othersInThreads.find((g) => g.conversation_id === t.id)?._count._all ?? 0,
      }
    }),
    dm_messages: (
      await tx.private_messages.findMany({
        where: { sender_id: id },
        ...oldestFirst,
        select: { conversation_id: true, message_text: true, media_url: true, media_type: true, created_at: true, moderation_status: true },
      })
    ).map(({ message_text, ...m }) => ({ ...m, text: message_text })),
    message_requests: messageRequests.map((r) =>
      r.sender_id === id
        ? { direction: "sent", person: person(r.recipient_id), message: r.message, status: r.status, created_at: r.created_at }
        : { direction: "received", person: person(r.sender_id), status: r.status, created_at: r.created_at }
    ),
    message_reports_filed: await tx.message_reports.findMany({
      where: { reporter_id: id },
      ...oldestFirst,
      select: { message_type: true, reason: true, description: true, status: true, created_at: true },
    }),
    user_reports_filed: (
      await tx.user_reports.findMany({
        where: { reporter_id: id },
        ...oldestFirst,
        select: { reported_id: true, reason: true, description: true, status: true, created_at: true },
      })
    ).map(({ reported_id, ...r }) => ({ ...r, person: person(reported_id) })),
    blocks: (await tx.blocked_users.findMany({ where: { blocker_id: id }, ...oldestFirst })).map((b) => ({
      person: person(b.blocked_id),
      seen_as: b.seen_as,
      created_at: b.created_at,
    })),
    friends: friendships.map((f) => ({ person: person(f.user1_id === id ? f.user2_id : f.user1_id), since: f.created_at })),
    friend_requests: friendRequests.map((r) => ({
      direction: r.sender_id === id ? "sent" : "received",
      person: person(r.sender_id === id ? r.recipient_id : r.sender_id),
      via: r.via,
      created_at: r.created_at,
      dismissed_at: r.dismissed_at,
      withdrawn_at: r.withdrawn_at,
    })),
    referral: referral && { invited_by: person(referral.inviter_id), created_at: referral.created_at },
    waves: waves.map((w) => ({
      direction: w.from_id === id ? "sent" : "received",
      person: person(w.from_id === id ? w.to_id : w.from_id),
      event_id: w.event_id,
      created_at: w.created_at,
    })),
    // Sent only: a like received is the liker's secret until it is mutual, as in the app.
    likes_sent: (await tx.event_likes.findMany({ where: { liker_id: id }, ...oldestFirst })).map((l) => ({
      person: person(l.liked_id),
      event_id: l.event_id,
      created_at: l.created_at,
    })),
    crews: await tx.crew_members.findMany({
      ...mine,
      orderBy: { joined_at: "asc" },
      select: { crew_id: true, role: true, joined_at: true, keep_me_anonymous: true, crew: { select: { name: true, dissolved_at: true } } },
    }),
    crew_invites: crewInvites.map((i) => ({
      direction: i.invited_user_id === id ? "received" : "sent",
      person: person(i.invited_user_id === id ? i.invited_by : i.invited_user_id),
      crew_id: i.crew_id,
      created_at: i.created_at,
      declined_at: i.declined_at,
      removed_at: i.removed_at,
    })),
    crew_hides: await tx.crew_hides.findMany({ ...mine, ...oldestFirst, select: { crew_id: true, created_at: true } }),
    blend_reveals: await tx.blend_reveals.findMany({ ...mine, select: { blend_id: true, revealed_at: true } }),
    board_posts: await tx.board_posts.findMany({
      where: { author_id: id },
      ...oldestFirst,
      select: { id: true, event_id: true, kind: true, sub_kind: true, body: true, photo_url: true, moderation_status: true, created_at: true, deleted_at: true },
    }),
    board_requests: boardRequests.map((r) =>
      r.from_user_id === id
        ? { direction: "sent", person: person(r.to_user_id), post_id: r.post_id, message: r.message, status: r.status, created_at: r.created_at }
        : { direction: "received", person: person(r.from_user_id), post_id: r.post_id, status: r.status, created_at: r.created_at }
    ),
    board_alerts: await tx.board_alert_preferences.findMany({ ...mine, omit: { user_id: true } }),
    // Kind and times only: a title or body is a push preview, other people's names and words.
    notifications: await tx.notifications.findMany({ ...mine, ...oldestFirst, select: { kind: true, created_at: true, read_at: true } }),
    product_events: await tx.product_events.findMany({ ...mine, orderBy: { occurred_at: "asc" }, select: { name: true, entity_kind: true, occurred_at: true } }),
    photo_checks: await tx.photo_checks.findMany({ ...mine, ...oldestFirst, select: { url: true, checked: true, hidden: true, pulled_at: true, created_at: true } }),
    city_demand: await tx.city_demand.findMany({ ...mine, select: { city: true, country: true, first_seen: true, last_seen: true, opens: true } }),
    market_previews: await tx.market_previewers.findMany({ ...mine, select: { market_code: true, created_at: true } }),
    venue_regulars: await tx.venue_regular_optins.findMany({ ...mine, select: { venue_id: true, created_at: true } }),
    venue_offer_mutes: await tx.venue_offer_mutes.findMany({ ...mine, select: { venue_id: true, created_at: true } }),
    venue_offers_received: await tx.venue_offer_sends.findMany({
      ...mine,
      orderBy: { sent_at: "asc" },
      select: { offer_id: true, venue_id: true, sent_at: true, opened_at: true, redeemed_at: true },
    }),
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/** Why this run must not go ahead, or null. Exported for the unit test. */
export function runRefusal(databaseUrl: string | undefined, args: string[]): string | null {
  const target = args.find((a) => !a.startsWith("--"))
  if (!target || args.some((a) => a.startsWith("--") && a !== "--allow-remote")) {
    return "usage: export-user.ts <email|userId> [--allow-remote]"
  }
  let host: string
  try {
    host = new URL(databaseUrl ?? "").hostname
  } catch {
    return "DATABASE_URL is not set or not a URL"
  }
  if (!LOCAL_HOSTS.has(host) && !args.includes("--allow-remote")) {
    return `${host} is not a local database; pass --allow-remote (platform staff only, see the runbook at the top of this file)`
  }
  return null
}

async function main() {
  const args = process.argv.slice(2)
  const refused = runRefusal(process.env.DATABASE_URL, args)
  if (refused) throw new Error(refused)
  const target = args.find((a) => !a.startsWith("--"))!
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
  try {
    const user = await db.user.findUnique({
      where: target.includes("@") ? { email: target.trim().toLowerCase() } : { id: target },
      select: { id: true },
    })
    if (!user) throw new Error("No account with that email or id")
    process.stdout.write(`${JSON.stringify(await exportUser(db, user.id), null, 2)}\n`)
  } finally {
    await db.$disconnect()
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
}
