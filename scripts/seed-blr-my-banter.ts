import { PrismaClient, type connection_intent } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { openConversation, conversationPair } from "../lib/conversations"
import { openSession } from "../lib/presence-sessions"
import { environmentRefusal } from "./test-accounts"
import { CROWD_DOMAIN } from "./seed-blr-crowd"
import { realEventsWhere } from "../lib/event-kind"

/**
 * Puts one real account into the Bengaluru scenario world, so the Banter tab —
 * rooms, matches, DMs, requests — can be judged with a life in it.
 *
 *   DATABASE_URL=... RAILWAY_ENVIRONMENT_NAME=staging npx tsx scripts/seed-blr-my-banter.ts            # dry run
 *   DATABASE_URL=... RAILWAY_ENVIRONMENT_NAME=staging npx tsx scripts/seed-blr-my-banter.ts --apply
 *   SEED_ME_EMAIL=someone@example.com ...   to target another account
 *
 * **Run after `seed-blr-scenarios.ts --apply`**, every time: that script
 * rebuilds the rooms, which takes this account's room memberships and room
 * messages with it. Conversations, likes and requests survive it.
 *
 * What the account ends up with:
 *
 *   - Inside the AI meetup right now (one live check-in — the app allows one).
 *   - Attended: board-game night (room still open), the Nandi ride (room
 *     archived), day 1 of the design festival.
 *   - Going to the jazz brunch, founders' breakfast and the coffee cupping
 *     (whose room is open early); interested in the rooftop sundowner.
 *   - Rooms with its own lines in them and some unread.
 *   - Matches from mutual likes, through `openConversation` — the same writer
 *     a real match uses — in every state the inbox draws: unread, you replied
 *     last, reveal requested, both revealed, an older thread from last week.
 *   - People who liked it back-less (incoming) and one it liked (outgoing).
 *   - Two pending message requests.
 *
 * Idempotent: rows between this account and the crowd are replaced each run;
 * nothing of the account's with anyone else is touched.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
const APPLY = process.argv.includes("--apply")
const EMAIL = (process.env.SEED_ME_EMAIL ?? "hemanth@unbothered.studio").trim().toLowerCase()

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.now()
const ago = (minutes: number) => new Date(NOW - minutes * MIN)

const LIVE = "blr-ai-in-production-meetup"
const ATTENDED = ["blr-board-game-night", "blr-nandi-sunrise-ride", "blr-design-festival"] as const
const GOING = ["blr-sunday-jazz-brunch", "blr-founders-breakfast", "blr-coffee-cupping"] as const
const INTERESTED = ["blr-rooftop-sundowner", "blr-singles-mixer"] as const

/** Room lines from this account, and what the room says to it. */
const ROOM_LINES: Record<string, { mine: string[]; replies: string[]; unread: number }> = {
  [LIVE]: {
    mine: ["the evals talk was exactly the problem we've been having", "anyone here working on voice agents?"],
    replies: ["yes! we're doing voice for support calls, happy to compare notes", "same, find me near the pizza after talk 3"],
    unread: 2,
  },
  "blr-board-game-night": {
    mine: ["table 4 was the best table, no contest", "thanks for teaching me Wingspan!"],
    replies: ["rematch next week?", "someone left a blue scarf at table 2"],
    unread: 1,
  },
  "blr-coffee-cupping": {
    mine: ["first cupping for me too, excited"],
    replies: ["see you there! bring questions for the roasters"],
    unread: 1,
  },
}

type Thread = {
  /** Which event the pair met at — only rooms both were in. */
  event: string
  /** Newest last. `me` is this account. */
  lines: [who: "me" | "them", text: string, minutesAgo: number][]
  /** Leave the last N incoming lines unread. */
  unread: number
  revealed: "none" | "me" | "them" | "both"
  revealRequestedByThem?: boolean
}

const THREADS: Thread[] = [
  {
    event: LIVE,
    revealed: "none",
    unread: 2,
    lines: [
      ["them", "hey! saw you asking about voice agents 👀", 14],
      ["them", "we're building one for clinics — want to grab a coffee after the talks?", 11],
    ],
  },
  {
    event: LIVE,
    revealed: "them",
    unread: 0,
    lines: [
      ["them", "matched! I'm the one in the green jacket near the back", 38],
      ["me", "ha, I see you. the 800 ms talk was great", 35],
      ["them", "right? we're way over budget on latency", 33],
      ["me", "same. let's talk after — I'll be near the pantry", 30],
    ],
  },
  {
    event: LIVE,
    revealed: "none",
    revealRequestedByThem: true,
    unread: 1,
    lines: [
      ["me", "hi 👋 enjoying the meetup?", 55],
      ["them", "loving it. first time at one of these", 52],
      ["me", "it's a good crowd. what do you work on?", 50],
      ["them", "mobile at a fintech — want to swap names?", 8],
    ],
  },
  {
    event: "blr-board-game-night",
    revealed: "both",
    unread: 0,
    lines: [
      ["them", "you were ruthless at Codenames 😂", 280],
      ["me", "I take my one-word clues very seriously", 275],
      ["them", "same time next week? I'll bring Azul", 260],
      ["me", "deal. I'll RSVP now", 255],
      ["them", "just did too", 250],
    ],
  },
  {
    event: "blr-nandi-sunrise-ride",
    revealed: "both",
    unread: 0,
    lines: [
      ["them", "that descent was freezing", 3 * 24 * 60 - 60],
      ["me", "never forgetting a jacket again", 3 * 24 * 60 - 55],
      ["them", "next ride is in two weeks if you're in", 2 * 24 * 60],
      ["me", "I'm in, send me the route", 2 * 24 * 60 - 30],
    ],
  },
]

const REQUESTS = [
  "Hi! We were both at board-game night — would love to talk about the design festival.",
  "Saw you at the AI meetup. I'm hiring for an ML role, open to a chat?",
]

async function main() {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host
    } catch {
      return "(unparseable DATABASE_URL)"
    }
  })()
  console.log(`\ndatabase: ${host}\naccount:  ${EMAIL}\nmode:     ${APPLY ? "APPLY" : "dry run"}\n`)
  const refusal = environmentRefusal(process.env)
  if (refusal) {
    console.error(`REFUSING: ${refusal}`)
    process.exitCode = 1
    return
  }

  const me = await db.user.findUnique({ where: { email: EMAIL }, select: { id: true, name: true } })
  if (!me) {
    console.error(`REFUSING: no account ${EMAIL}`)
    process.exitCode = 1
    return
  }
  const events = new Map(
    (await db.events.findMany({ where: { slug: { startsWith: "blr-" }, deleted_at: null, ...realEventsWhere }, select: { id: true, slug: true, title: true, latitude: true, longitude: true, start_time: true, end_time: true } })).map((e) => [e.slug, e])
  )
  for (const slug of [LIVE, ...ATTENDED, ...GOING]) {
    if (!events.has(slug)) {
      console.error(`REFUSING: ${slug} missing — run seed-blr-scenarios.ts --apply first`)
      process.exitCode = 1
      return
    }
  }
  const crowd = await db.user.findMany({ where: { email: { endsWith: `@${CROWD_DOMAIN}` } }, select: { id: true } })
  const crowdIds = crowd.map((c) => c.id)
  if (crowdIds.length === 0) {
    console.error("REFUSING: no crowd — run seed-blr-scenarios.ts --apply first")
    process.exitCode = 1
    return
  }

  console.log(`${me.name ?? EMAIL}: live at ${LIVE}; attended ${ATTENDED.join(", ")}`)
  console.log(`  ${THREADS.length} matches with DMs, 2 incoming likes, 1 outgoing, ${REQUESTS.length} message requests`)
  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.\n")
    return
  }

  const event = (slug: string) => events.get(slug)!
  const others = (eventId: string, status: "checked_in" | "checked_out") =>
    db.event_check_ins.findMany({ where: { event_id: eventId, status, user_id: { in: crowdIds } }, orderBy: { check_in_time: "asc" }, select: { user_id: true } }).then((r) => [...new Set(r.map((x) => x.user_id))])

  /* ── clear what this script owns ───────────────────────────────────────── */
  const blrIds = [...events.values()].map((e) => e.id)
  await db.presence_sessions.deleteMany({ where: { user_id: me.id, event_id: { in: blrIds } } })
  await db.event_check_ins.deleteMany({ where: { user_id: me.id, event_id: { in: blrIds } } })
  await db.event_rsvps.deleteMany({ where: { user_id: me.id, event_id: { in: blrIds } } })
  await db.event_favorites.deleteMany({ where: { user_id: me.id, event_id: { in: blrIds } } })
  await db.event_match_preferences.deleteMany({ where: { user_id: me.id, event_id: { in: blrIds } } })
  await db.event_likes.deleteMany({ where: { event_id: { in: blrIds }, OR: [{ liker_id: me.id }, { liked_id: me.id }] } })
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: crowdIds }, recipient_id: me.id }, { sender_id: me.id, recipient_id: { in: crowdIds } }] } })
  const pairs = crowdIds.map((c) => conversationPair(me.id, c))
  await db.private_conversations.deleteMany({ where: { OR: pairs.map(([user1_id, user2_id]) => ({ user1_id, user2_id })) } })

  /* ── check-ins ─────────────────────────────────────────────────────────── */
  const live = event(LIVE)
  const liveOcc = await db.event_occurrences.findFirst({ where: { event_id: live.id, start_time: { lte: new Date(NOW + 90 * MIN) }, end_time: { gte: new Date(NOW) } } })
  if (!liveOcc) throw new Error(`${LIVE} has no live occurrence — re-run seed-blr-scenarios.ts --apply to put the clock back`)
  const checkedInAt = ago(70)
  await db.event_check_ins.create({
    data: { event_id: live.id, occurrence_id: liveOcc.id, user_id: me.id, kind: "attendee", status: "checked_in", check_in_time: checkedInAt, latitude: live.latitude, longitude: live.longitude, device_info: { platform: "ios", source: "seed-blr-my-banter" }, last_seen_at: new Date() },
  })
  const session = await openSession({ eventId: live.id, occurrenceId: liveOcc.id, userId: me.id, at: checkedInAt, source: "polling" })
  await db.presence_sessions.update({ where: { id: session.id }, data: { last_seen_at: new Date() } })

  for (const slug of ATTENDED) {
    const e = event(slug)
    const occ = await db.event_occurrences.findFirst({ where: { event_id: e.id, end_time: { lt: new Date(NOW) } }, orderBy: { start_time: "asc" } })
    if (!occ) continue
    const inAt = new Date(occ.start_time.getTime() + 20 * MIN)
    const outAt = new Date(occ.end_time.getTime() - 15 * MIN)
    await db.event_check_ins.create({
      data: { event_id: e.id, occurrence_id: occ.id, user_id: me.id, kind: "attendee", status: "checked_out", check_in_time: inAt, check_out_time: outAt, latitude: e.latitude, longitude: e.longitude, device_info: { platform: "ios", source: "seed-blr-my-banter" }, last_seen_at: outAt },
    })
  }

  const intent: connection_intent[] = ["networking", "friendship"]
  for (const slug of [LIVE, ...ATTENDED]) {
    await db.event_match_preferences.create({ data: { event_id: event(slug).id, user_id: me.id, intent, revealed: false } })
  }
  for (const [i, slug] of [LIVE, ...ATTENDED, ...GOING].entries()) {
    await db.event_rsvps.create({ data: { event_id: event(slug).id, user_id: me.id, status: "going", created_at: new Date(NOW - (10 - i) * 24 * HOUR) } })
  }
  for (const slug of INTERESTED) {
    const e = events.get(slug)
    if (e) await db.event_favorites.create({ data: { event_id: e.id, user_id: me.id } })
  }

  /* ── rooms ─────────────────────────────────────────────────────────────── */
  const handleOf = new Map<string, string>()
  for (const [slug, room] of Object.entries(ROOM_LINES)) {
    const group = await db.chat_groups.findUnique({ where: { event_id: event(slug).id } })
    if (!group) continue
    const taken = new Set((await db.chat_group_members.findMany({ where: { chat_group_id: group.id }, select: { anonymous_name: true } })).map((m) => m.anonymous_name))
    const handle = ["Curious Heron", "Sunny Koel", "Brisk Lynx", "Clever Myna"].find((h) => !taken.has(h)) ?? `Guest ${taken.size + 1}`
    await db.chat_group_members.deleteMany({ where: { chat_group_id: group.id, user_id: me.id } })
    await db.chat_messages.deleteMany({ where: { chat_group_id: group.id, user_id: me.id } })
    const member = await db.chat_group_members.create({
      data: { chat_group_id: group.id, user_id: me.id, anonymous_name: handle, status: group.status === "archived" ? "left" : "active", joined_at: ago(90) },
    })
    handleOf.set(event(slug).id, handle)

    // My lines, then the room answering; the last `unread` answers land after my read marker.
    const speakers = await db.chat_group_members.findMany({ where: { chat_group_id: group.id, user_id: { not: me.id }, role: "member", status: "active" }, take: room.replies.length, select: { user_id: true } })
    const last = group.last_message_at ? Math.min(group.last_message_at.getTime(), NOW) : NOW - 30 * MIN
    let t = last - (room.mine.length + room.replies.length + 1) * 4 * MIN
    let lastRead: string | null = null
    for (const text of room.mine) {
      const m = await db.chat_messages.create({ data: { chat_group_id: group.id, user_id: me.id, content: text, moderation_status: "clean", created_at: new Date((t += 4 * MIN)) } })
      lastRead = m.id
    }
    for (const [i, text] of room.replies.entries()) {
      const speaker = speakers[i % Math.max(1, speakers.length)]?.user_id
      if (!speaker) break
      const m = await db.chat_messages.create({ data: { chat_group_id: group.id, user_id: speaker, content: text, moderation_status: "clean", created_at: new Date((t += 4 * MIN)) } })
      if (i < room.replies.length - room.unread) lastRead = m.id
    }
    await db.chat_group_members.update({ where: { id: member.id }, data: { last_read_message_id: lastRead } })
    const newest = await db.chat_messages.findFirst({ where: { chat_group_id: group.id }, orderBy: { created_at: "desc" }, select: { created_at: true } })
    await db.chat_groups.update({
      where: { id: group.id },
      data: { member_count: await db.chat_group_members.count({ where: { chat_group_id: group.id, status: "active" } }), last_message_at: newest?.created_at ?? null },
    })
  }

  /* ── matches and DMs ───────────────────────────────────────────────────── */
  const used = new Set<string>()
  const partnerAt = async (slug: string) => {
    const e = event(slug)
    const pool = await others(e.id, slug === LIVE ? "checked_in" : "checked_out")
    const pick = pool.find((id) => !used.has(id))
    if (pick) used.add(pick)
    return pick
  }
  for (const thread of THREADS) {
    const e = event(thread.event)
    const them = await partnerAt(thread.event)
    if (!them) {
      console.log(`  !  nobody left to match with at ${thread.event}`)
      continue
    }
    const firstAt = ago(thread.lines[0][2] + 3)
    await db.event_likes.create({ data: { event_id: e.id, liker_id: me.id, liked_id: them, created_at: firstAt } })
    await db.event_likes.create({ data: { event_id: e.id, liker_id: them, liked_id: me.id, created_at: firstAt } })

    const theirHandle = (await db.chat_group_members.findFirst({ where: { chat_group: { event_id: e.id }, user_id: them }, select: { anonymous_name: true } }))?.anonymous_name ?? "Attendee"
    const conversation = await openConversation(me.id, them, {
      eventId: e.id,
      pseudonyms: { [me.id]: handleOf.get(e.id) ?? "Attendee", [them]: theirHandle },
      revealed: thread.revealed === "both" ? [me.id, them] : thread.revealed === "me" ? [me.id] : thread.revealed === "them" ? [them] : [],
    })
    const meIsUser1 = conversation.user1_id === me.id
    const incoming = thread.lines.filter(([who]) => who === "them").length
    let seenIncoming = 0
    for (const [who, text, minutesAgo] of thread.lines) {
      const fromThem = who === "them"
      if (fromThem) seenIncoming++
      await db.private_messages.create({
        data: {
          conversation_id: conversation.id,
          sender_id: fromThem ? them : me.id,
          message_text: text,
          moderation_status: "clean",
          is_read: fromThem ? seenIncoming <= incoming - thread.unread : true,
          created_at: ago(minutesAgo),
          updated_at: ago(minutesAgo),
        },
      })
    }
    await db.private_conversations.update({
      where: { id: conversation.id },
      data: {
        created_at: firstAt,
        last_message_at: ago(thread.lines[thread.lines.length - 1][2]),
        ...(thread.revealRequestedByThem && (meIsUser1 ? { user2_reveal_requested: true } : { user1_reveal_requested: true })),
      },
    })
  }

  // Liked me, I haven't liked back — the "someone liked you" state.
  const live2 = event(LIVE)
  for (let i = 0; i < 2; i++) {
    const them = await partnerAt(LIVE)
    if (them) await db.event_likes.create({ data: { event_id: live2.id, liker_id: them, liked_id: me.id, created_at: ago(20 + i * 7) } })
  }
  // I liked, they haven't yet.
  const pending = await partnerAt(LIVE)
  if (pending) await db.event_likes.create({ data: { event_id: live2.id, liker_id: me.id, liked_id: pending, created_at: ago(12) } })

  /* ── message requests ─────────────────────────────────────────────────── */
  for (const [i, message] of REQUESTS.entries()) {
    const sender = await partnerAt(i === 0 ? "blr-board-game-night" : LIVE)
    if (sender) await db.message_requests.create({ data: { sender_id: sender, recipient_id: me.id, message, status: "pending", created_at: ago(25 + i * 90) } })
  }

  console.log("\nDone. Pull to refresh the Banter tab.\n")
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
