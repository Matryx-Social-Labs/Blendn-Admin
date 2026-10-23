import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { preferredPseudonymFor, pseudonymSchemeFor, type PseudonymScheme } from "../lib/anonymous-names"
import { realEventsWhere, SYSTEM_USER_ID } from "../lib/event-kind"
import PORTRAITS from "./seed-blr-portraits.json"
import { environmentRefusal } from "./test-accounts"
import {
  EVENT_SLUG_PREFIX,
  ID_PREFIX,
  PER_TARGET,
  PLUS_REF_PREFIX,
  ROOM_STRANGERS,
  TARGET_EMAILS,
  VENUE_SOURCE,
  crowdId,
  layoutFor,
  uuidFor,
  plannedCounts,
  plusCompRefusal,
} from "./seed-qa-scale-plan"
import {
  QA_VENUE_ID,
  boardRows,
  banterRows,
  crowdRows,
  eventRows,
  historyRows,
  roomMemberId,
  roomMemberRows,
  roomRows,
  socialRows,
  venueRow,
  type LiveRoom,
  type Target,
} from "./seed-qa-scale-rows"

/**
 * Data at scale, for the drives that cannot be done on a thin staging: 1,000
 * friends, 60 friends in one room, a 300-person grid, a Banter past one page,
 * Going and its history past one page, a venue with more than five coming
 * events, a board past one page, and Blendn+ on a throwaway account.
 *
 *   DATABASE_URL=... npx tsx scripts/seed-qa-scale.ts                      # dry run: the plan and what is there
 *   DATABASE_URL=... npx tsx scripts/seed-qa-scale.ts --apply
 *   DATABASE_URL=... npx tsx scripts/seed-qa-scale.ts --apply --grant-plus qa.rc.c@blendn.app
 *   DATABASE_URL=... npx tsx scripts/seed-qa-scale.ts --remove             # everything it made, and the comp
 *
 *   --event <slug> --second-event <slug>   pick the two live events (default: the first two live ones)
 *   --board-event <slug>                   pick the event the board posts go on (default: the first
 *                                          qa-scale-soon-NN whose doors have not opened)
 *
 * ## The rooms' chat, and the board
 *
 * A check-in alone does not put anybody in the room's chat: the door
 * (`seatInRoom`, lib/check-in-core.ts) also writes a `chat_group_members` row
 * with a handle. So every room check-in here gets the same row, and the room
 * (`chat_groups`) is made when the event has none, as `createRoom` makes it.
 * The big room then holds 483 chat members (3 targets + 180 friends + 300
 * strangers). `seatInRoom` itself cannot be called from a script (it pulls in
 * the push and socket modules), so `__tests__/seed-qa-scale.test.ts` pins this
 * to its source.
 *
 * The board closes at doors (the board route: `start_time <= now` is
 * BOARD_CLOSED, read and write), so its 120 posts go on an event that has not
 * started and the targets are going to, not in the live room.
 *
 * ## Who it touches
 *
 * The three throwaway targets (`qa.rc.a|b|c@blendn.app`) are looked up, never
 * created, and nothing on them is edited: no password, no profile. What they
 * get are rows that point at them (friendships, requests, DMs, RSVPs, check-ins).
 * A target that does not exist is skipped with a line saying so.
 *
 * ## Staging or this machine, nothing else
 *
 * The same allow-list as `seed:qa` (`environmentRefusal`), checked first, for the
 * dry run too. It writes no password, so it does not need `SEED_PASSWORD`.
 *
 * ## What `--remove` leaves
 *
 * Zero `qa.scale.*` users and nothing owned by them (friendships, requests,
 * DMs, messages, check-ins, sessions, RSVPs, board posts cascade from `User`),
 * none of the `qa-scale-*` events or their days, the QA venue, and no comp.
 * The targets are as they were, with one exception it cannot undo: a target
 * that was checked in somewhere else is checked OUT of it so it can enter the
 * big room (one open check-in per person, `event_check_ins_one_open_per_user`).
 *
 * ## Idempotent, and what a re-run is for
 *
 * Every id is derived from a key, so `--apply` again skips what is there. It
 * does refresh the two rooms' check-ins and sessions (`last_seen_at`, the
 * people it had checked out): run it again before a drive. The events are dated
 * from the first run; to re-date them, `--remove` then `--apply`.
 */

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const valueOf = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const valuesOf = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []))

const APPLY = flag("--apply")
const REMOVE = flag("--remove")
const PLUS_EMAILS = valuesOf("--grant-plus")

const CHUNK = 1000
const WIDE_CHUNK = 400
const REMOVE_USERS_AT_A_TIME = 200
const REMOVE_EVENTS_AT_A_TIME = 10
const COMP_DAYS = 365
const DAY_MS = 24 * 60 * 60 * 1000

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })

/* -------------------------------------------------------------------------- */
/* Small helpers                                                                */
/* -------------------------------------------------------------------------- */

const say = (line = "") => console.log(line)

async function put<T>(label: string, rows: T[], size: number, write: (chunk: T[]) => Promise<{ count: number }>): Promise<void> {
  let written = 0
  for (let at = 0; at < rows.length; at += size) written += (await write(rows.slice(at, at + size))).count
  say(`  ${label.padEnd(24)} ${String(written).padStart(6)} new of ${rows.length}`)
}

const slices = <T>(rows: readonly T[], size: number) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size))

const crowdUserIds = async () => (await db.user.findMany({ where: { id: { startsWith: ID_PREFIX } }, select: { id: true } })).map((u) => u.id)

async function findTargets(): Promise<Target[]> {
  const rows = await db.user.findMany({ where: { email: { in: [...TARGET_EMAILS] }, deletedAt: null }, select: { id: true, email: true } })
  // The order the plan lays them out in, whatever order the database returned.
  return TARGET_EMAILS.flatMap((email) => rows.filter((r) => r.email === email))
}

/* -------------------------------------------------------------------------- */
/* The two live events                                                          */
/* -------------------------------------------------------------------------- */

interface Live extends LiveRoom {
  slug: string
  title: string
}

/**
 * The events the rooms go in: real, published, live now, and not ours. A named
 * event must be one of those too; a room in an event that has ended would hold
 * nobody.
 */
async function liveEvents(now: Date): Promise<Live[]> {
  const named = [valueOf("--event"), valueOf("--second-event")].filter((s): s is string => !!s)
  const candidates = await db.events.findMany({
    where: {
      ...realEventsWhere,
      deleted_at: null,
      status: "published",
      start_time: { lte: now },
      end_time: { gt: now },
      slug: named.length ? { in: named } : { not: { startsWith: EVENT_SLUG_PREFIX } },
      occurrences: { some: { cancelled_at: null, start_time: { lte: now }, end_time: { gt: now } } },
    },
    orderBy: [{ start_time: "asc" }, { slug: "asc" }],
    select: {
      id: true,
      slug: true,
      title: true,
      occurrences: { where: { cancelled_at: null, start_time: { lte: now }, end_time: { gt: now } }, orderBy: { start_time: "desc" }, take: 1, select: { id: true } },
    },
  })
  const live = candidates.map((e) => ({ eventId: e.id, occurrenceId: e.occurrences[0].id, slug: e.slug, title: e.title }))
  return named.length ? named.flatMap((slug) => live.filter((l) => l.slug === slug)) : live
}

/* -------------------------------------------------------------------------- */
/* Read-back: the dry run's "what is there" and the check after --apply         */
/* -------------------------------------------------------------------------- */

const tagged = { device_info: { path: ["qaScale"], equals: true } } as const

async function readBack(targets: readonly Target[], now: Date) {
  const crowd = await db.user.count({ where: { id: { startsWith: ID_PREFIX } } })
  const [emailRows, profiles, interests, events, venueEvents, board] = await Promise.all([
    db.user.count({ where: { email: { startsWith: "qa.scale." } } }),
    db.profiles.count({ where: { id: { startsWith: ID_PREFIX } } }),
    db.user_interests.count({ where: { user_id: { startsWith: ID_PREFIX } } }),
    // any-kind: the seed's own events and its venue days are counted together
    db.events.count({ where: { slug: { startsWith: EVENT_SLUG_PREFIX } } }),
    db.events.count({
      where: { ...realEventsWhere, venue_id: QA_VENUE_ID, deleted_at: null, status: "published", visibility: "public", end_time: { gte: now } },
    }),
    db.board_posts.count({ where: { author_id: { startsWith: ID_PREFIX }, deleted_at: null } }),
  ])
  say(`  crowd users              ${crowd}  (qa.scale.* addresses: ${emailRows}, profiles: ${profiles}, user_interests: ${interests})`)
  say(`  qa-scale events          ${events}  (coming up at the QA venue: ${venueEvents}, board posts: ${board})`)

  const rooms = await db.event_check_ins.groupBy({ by: ["event_id"], where: { status: "checked_in", ...tagged }, _count: { _all: true } })
  say(`  open QA check-ins        ${rooms.map((r) => `${r._count._all} in ${r.event_id.slice(0, 8)}`).join(", ") || "none"}`)

  // Chat members of the rooms those check-ins are in: the crowd's rows plus the targets' own.
  // any-kind: read-back by room, whatever the event's kind; a venue day's room is listed by its slug too
  const roomMembers = await db.$queryRaw<{ slug: string; members: bigint; member_count: number }[]>`
    SELECT e.slug, count(m.id) AS members, g.member_count
      FROM chat_groups g
      JOIN events e ON e.id = g.event_id
      JOIN chat_group_members m ON m.chat_group_id = g.id
     WHERE m.user_id LIKE ${`${ID_PREFIX}%`} OR m.user_id = ANY(${targets.map((t) => t.id)}::text[])
     GROUP BY e.slug, g.member_count ORDER BY e.slug`
  say(`  room chat members        ${roomMembers.map((r) => `${r.members} in ${r.slug} (member_count ${r.member_count})`).join(", ") || "none"}`)

  const boards = await db.board_posts.groupBy({ by: ["event_id"], where: { author_id: { startsWith: ID_PREFIX }, deleted_at: null }, _count: { _all: true } })
  // any-kind: the events the seed's own posts sit on, looked up by id for the read-back line
  const boardEvents = await db.events.findMany({ where: { id: { in: boards.map((b) => b.event_id) } }, select: { id: true, slug: true, title: true, start_time: true } })
  for (const b of boards) {
    const event = boardEvents.find((e) => e.id === b.event_id)
    // The board route's own clock: closed once start_time <= now.
    const open = !!event && event.start_time > now
    say(`  board posts              ${b._count._all} on ${event?.slug} (${event?.title}): board ${open ? `OPEN, doors ${event?.start_time.toISOString()}` : "CLOSED"}`)
  }

  for (const target of targets) {
    const friendRows = await db.friendships.findMany({
      where: { OR: [{ user1_id: target.id }, { user2_id: target.id }] },
      select: { user1_id: true, user2_id: true },
    })
    const friendIds = friendRows.map((f) => (f.user1_id === target.id ? f.user2_id : f.user1_id))
    // Friends here, by the route's own predicate (lib/friends-here.ts): checked in, an attendee, opted in, showing online.
    const hereByEvent = await db.event_check_ins.groupBy({
      by: ["event_id"],
      where: {
        user_id: { in: friendIds },
        status: "checked_in",
        kind: "attendee",
        user: { suspended_at: null, deletedAt: null, profile: { is: { friends_see_me_in_rooms: true, show_online: true } } },
      },
      _count: { _all: true },
    })
    const [pendingFriends, pendingMessages, inbox, ratable, going, nights] = await Promise.all([
      db.friend_requests.count({ where: { recipient_id: target.id, held_at: null, dismissed_at: null, withdrawn_at: null } }),
      db.message_requests.count({ where: { recipient_id: target.id, status: "pending" } }),
      db.private_conversations.count({ where: { closed_at: null, OR: [{ user1_id: target.id }, { user2_id: target.id }] } }),
      db.private_conversations.count({ where: { origin_event_id: { not: null }, closed_at: null, OR: [{ user1_id: target.id }, { user2_id: target.id }] } }),
      db.event_rsvps.count({ where: { user_id: target.id, status: "going", event: { ...realEventsWhere, deleted_at: null, end_time: { gte: now } } } }),
      db.event_check_ins.count({ where: { user_id: target.id, status: "checked_out", ...tagged } }),
    ])
    say(`  ${target.email.padEnd(20)} friends ${friendIds.length}, friends here ${hereByEvent.map((h) => h._count._all).join(" / ") || "0"}, friend requests ${pendingFriends}, message requests ${pendingMessages},`)
    say(`  ${"".padEnd(20)} inbox ${inbox} (of which matches to rate ${ratable}), going ${going}, nights attended ${nights}`)
  }
  const comps = await db.entitlements.findMany({ where: { source: "grant", external_ref: { startsWith: PLUS_REF_PREFIX } }, select: { subject_id: true, expires_at: true } })
  say(`  Blendn+ comps            ${comps.length}${comps.map((c) => ` (${c.subject_id.slice(0, 8)} until ${c.expires_at?.toISOString().slice(0, 10)})`).join("")}`)
}

/* -------------------------------------------------------------------------- */
/* --apply                                                                      */
/* -------------------------------------------------------------------------- */

/** One open check-in per person: check the given people out of any room but `keep`, never before they arrived. */
async function leaveOtherRooms(userIds: readonly string[], keepOccurrenceId: string, at: Date) {
  for (const ids of slices(userIds, CHUNK)) {
    await db.$executeRaw`
      UPDATE event_check_ins
         SET status = 'checked_out', check_out_time = GREATEST(check_in_time, ${at}::timestamptz), updated_at = now()
       WHERE user_id = ANY(${ids}::text[]) AND status = 'checked_in' AND occurrence_id <> ${keepOccurrenceId}::uuid`
    await db.$executeRaw`
      UPDATE presence_sessions
         SET departed_at = GREATEST(arrived_at, ${at}::timestamptz), departed_source = 'switch', updated_at = now()
       WHERE user_id = ANY(${ids}::text[]) AND departed_at IS NULL AND occurrence_id <> ${keepOccurrenceId}::uuid`
  }
}

async function apply(targets: Target[], now: Date) {
  const live = await liveEvents(now)
  if (live.length < 2) {
    throw new Error(
      `Need two live events to put the rooms in, found ${live.length}. ` +
        "Re-time the seeded ones (`seed-blr-scenarios --refresh-times` or `seed-qa --refresh-times`), or name two with --event and --second-event."
    )
  }
  const [bigLive, secondLive] = live
  const system = await db.user.findUnique({ where: { id: SYSTEM_USER_ID }, select: { id: true } })
  if (!system) throw new Error(`Visits need the ${SYSTEM_USER_ID} user: build this database with db:migrate, not db:push`)

  say(`  big room:    ${bigLive.slug}  (${bigLive.title})`)
  say(`  second room: ${secondLive.slug}  (${secondLive.title})\n`)

  const layout = layoutFor(targets.length)
  const leaves = (await db.categories.findMany({ where: { parent_id: { not: null } }, orderBy: { slug: "asc" }, select: { id: true } })).map((c) => c.id)
  const portraits = {
    woman: (PORTRAITS as { women: { id: string }[] }).women.map((p) => p.id),
    man: (PORTRAITS as { men: { id: string }[] }).men.map((p) => p.id),
  }

  const crowd = crowdRows(layout, portraits, now, leaves)
  await put("users", crowd.users, CHUNK, (data) => db.user.createMany({ data, skipDuplicates: true }))
  await put("profiles", crowd.profiles, WIDE_CHUNK, (data) => db.profiles.createMany({ data, skipDuplicates: true }))
  await put("user_interests", crowd.interests, CHUNK, (data) => db.user_interests.createMany({ data, skipDuplicates: true }))

  const social = socialRows(layout, targets, now)
  await put("friendships", social.friendships, CHUNK, (data) => db.friendships.createMany({ data, skipDuplicates: true }))
  await put("friend requests", social.friendRequests, CHUNK, (data) => db.friend_requests.createMany({ data, skipDuplicates: true }))
  await put("message requests", social.messageRequests, CHUNK, (data) => db.message_requests.createMany({ data, skipDuplicates: true }))

  await db.venues.upsert({ where: { id: QA_VENUE_ID }, update: {}, create: venueRow() })
  const world = eventRows(now, crowdId(layout.host), SYSTEM_USER_ID)
  await put("events", world.events, WIDE_CHUNK, (data) => db.events.createMany({ data, skipDuplicates: true }))
  await put("occurrences", world.occurrences, CHUNK, (data) => db.event_occurrences.createMany({ data, skipDuplicates: true }))

  // Banter's matches point at the first past nights, so they follow the events.
  const banter = banterRows(layout, targets, now)
  await put("conversations", banter.conversations, CHUNK, (data) => db.private_conversations.createMany({ data, skipDuplicates: true }))
  await put("private messages", banter.messages, CHUNK, (data) => db.private_messages.createMany({ data, skipDuplicates: true }))

  const history = historyRows(layout, targets, now)
  await put("RSVPs", history.rsvps, CHUNK, (data) => db.event_rsvps.createMany({ data, skipDuplicates: true }))
  await put("history check-ins", history.checkIns, CHUNK, (data) => db.event_check_ins.createMany({ data, skipDuplicates: true }))
  await put("history sessions", history.sessions, CHUNK, (data) => db.presence_sessions.createMany({ data, skipDuplicates: true }))

  const big: LiveRoom = { eventId: bigLive.eventId, occurrenceId: bigLive.occurrenceId }
  const second: LiveRoom = { eventId: secondLive.eventId, occurrenceId: secondLive.occurrenceId }
  const rooms = roomRows(layout, targets, now, big, second, await targetsAlreadyThere(targets, [bigLive, secondLive]))
  const bigPeople = rooms.checkIns.filter((c) => c.occurrence_id === big.occurrenceId).map((c) => c.user_id)
  const secondPeople = rooms.checkIns.filter((c) => c.occurrence_id === second.occurrenceId).map((c) => c.user_id)
  await leaveOtherRooms(bigPeople, big.occurrenceId, now)
  await leaveOtherRooms(secondPeople, second.occurrenceId, now)
  await put("room check-ins", rooms.checkIns, CHUNK, (data) => db.event_check_ins.createMany({ data, skipDuplicates: true }))
  await put("room sessions", rooms.sessions, CHUNK, (data) => db.presence_sessions.createMany({ data, skipDuplicates: true }))
  await refreshRooms(rooms.checkIns.map((c) => c.id as string), rooms.sessions.map((s) => s.id as string), now)

  await seatRoomMembers(rooms.checkIns, [bigLive, secondLive])

  const board = await boardEvent(now)
  say(`  board:       ${board.slug}  (${board.title}), doors ${board.start.toISOString()}`)
  // An earlier run put the posts on a live room, where the board is closed: move them, they are ours (qascale_ authors, no room).
  const moved = await db.board_posts.deleteMany({ where: { author_id: { startsWith: ID_PREFIX }, event_id: { not: board.eventId }, room: { is: null } } })
  if (moved.count) say(`  board posts              ${moved.count} taken off other events`)
  await ensureRoom(board.eventId, board.title)
  await put("board posts", boardRows(layout, board, now), CHUNK, (data) => db.board_posts.createMany({ data, skipDuplicates: true }))
}

/**
 * The event the board posts go on: the board is open while `start_time > now`
 * (the board route, read and write), and the targets are going to every
 * qa-scale-soon-NN, so the first of those whose doors are ahead. A named one
 * must pass the same test.
 */
async function boardEvent(now: Date) {
  const named = valueOf("--board-event")
  const found = await db.events.findFirst({
    where: {
      ...realEventsWhere,
      deleted_at: null,
      status: "published",
      start_time: { gt: now },
      slug: named ?? { startsWith: `${EVENT_SLUG_PREFIX}soon-` },
    },
    orderBy: [{ start_time: "asc" }, { slug: "asc" }],
    select: { id: true, slug: true, title: true, start_time: true },
  })
  if (!found) {
    throw new Error(
      `No event to put the board on: ${named ? `${named} is not a published event whose doors are still ahead` : "every qa-scale-soon-NN has started"}. ` +
        "The board closes at doors; `--remove` then `--apply` re-dates the seeded events."
    )
  }
  return { eventId: found.id, slug: found.slug, title: found.title, start: found.start_time }
}

/** The room, made as `createRoom` (lib/check-in-core.ts) makes an event's: found, or created. */
async function ensureRoom(eventId: string, title: string): Promise<string> {
  const have = await db.chat_groups.findUnique({ where: { event_id: eventId }, select: { id: true } })
  if (have) return have.id
  const eventTitle = title || "Event"
  const made = await db.chat_groups.create({
    data: { event_id: eventId, name: `${eventTitle} Chat`, description: `Chat for ${eventTitle}`, status: "active", member_count: 0 },
    select: { id: true },
  })
  return made.id
}

/**
 * Everyone checked in to a live room is in its chat, with a handle, as a real
 * check-in leaves them. Idempotent: a person already in the room (this seed's
 * row, or a real one) is left alone, except that a `left` member is brought
 * back, which is what a check-in does. A ban or a mute stays.
 */
async function seatRoomMembers(checkIns: readonly { event_id: string; user_id: string }[], lives: readonly Live[]) {
  for (const live of lives) {
    const people = [...new Set(checkIns.filter((c) => c.event_id === live.eventId).map((c) => c.user_id))].sort()
    const chatGroupId = await ensureRoom(live.eventId, live.title)
    const there = await db.chat_group_members.findMany({ where: { chat_group_id: chatGroupId }, select: { user_id: true, anonymous_name: true } })
    const already = new Set(there.map((m) => m.user_id))
    const taken = new Set(there.flatMap((m) => (m.anonymous_name ? [m.anonymous_name] : [])))
    // Keyed handles need the server secret; without it (a script run) the unkeyed derivation is still a valid one.
    const scheme: PseudonymScheme = process.env.NEXTAUTH_SECRET ? await pseudonymSchemeFor(live.eventId, db) : "legacy"
    const handle = (userId: string, attempt: number) => preferredPseudonymFor(live.eventId, attempt ? `${userId}#${attempt}` : userId, scheme)

    const rows = roomMemberRows(chatGroupId, live.eventId, people.filter((id) => !already.has(id)), handle, taken)
    await put(`chat members (${live.slug.slice(0, 8)})`, rows, CHUNK, (data) => db.chat_group_members.createMany({ data, skipDuplicates: true }))
    await db.chat_group_members.updateMany({
      where: { chat_group_id: chatGroupId, user_id: { in: people }, status: "left" },
      data: { status: "active", left_at: null, updated_at: new Date() },
    })
    await recountMembers([chatGroupId])
  }
}

/** `member_count` is one per membership row (the door increments on each new one): set it from the rows rather than adding to it. */
async function recountMembers(chatGroupIds: readonly string[]) {
  if (!chatGroupIds.length) return
  await db.$executeRaw`
    UPDATE chat_groups g SET member_count = (SELECT count(*) FROM chat_group_members m WHERE m.chat_group_id = g.id)
     WHERE g.id = ANY(${chatGroupIds}::uuid[])`
}

/**
 * The (occurrence:person) pairs to leave out of the rooms: a target that already has a row in one of the
 * two occurrences (a real check-in, theirs) keeps it. The unique (occurrence, person) would refuse a
 * second, and rewriting their row would be editing the account. Nothing of theirs is then written there,
 * so `--remove` has nothing of theirs to find; if the row is not an open one, they are told they are not in the room.
 */
async function targetsAlreadyThere(targets: readonly Target[], lives: readonly Live[]): Promise<Set<string>> {
  const existing = await db.event_check_ins.findMany({
    where: { occurrence_id: { in: lives.map((l) => l.occurrenceId) }, user_id: { in: targets.map((t) => t.id) } },
    select: { id: true, user_id: true, occurrence_id: true, status: true },
  })
  const theirs = existing.filter((row) => row.id !== uuidFor(`checkin:${row.occurrence_id}:${row.user_id}`))
  for (const row of theirs) {
    const slug = lives.find((l) => l.occurrenceId === row.occurrence_id)?.slug
    const email = targets.find((t) => t.id === row.user_id)?.email
    say(`  !  ${email} already has a ${row.status} check-in in ${slug}: left as it is${row.status === "checked_in" ? "" : " (so they are not in that room)"}`)
  }
  return new Set(theirs.map((row) => `${row.occurrence_id}:${row.user_id}`))
}

/** Back in the room, seen just now: what a re-run is for, since a session last seen ten minutes ago counts as nobody inside. */
async function refreshRooms(checkInIds: string[], sessionIds: string[], now: Date) {
  for (const ids of slices(checkInIds, CHUNK)) {
    await db.event_check_ins.updateMany({
      where: { id: { in: ids } },
      data: { status: "checked_in", check_out_time: null, last_seen_at: now, left_area_at: null, departure_prompted_at: null },
    })
  }
  for (const ids of slices(sessionIds, CHUNK)) {
    await db.presence_sessions.updateMany({ where: { id: { in: ids } }, data: { departed_at: null, departed_source: null, last_seen_at: now } })
  }
  say(`  refreshed                ${checkInIds.length} check-ins, ${sessionIds.length} sessions`)
}

/* -------------------------------------------------------------------------- */
/* Blendn+                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A comp: an active `plus` row from source `grant`, which `GET /me/plus` reads
 * as `active: true, source: "grant"` and Manage shows as "Blend'n+ until <date> ·
 * nothing renews". It is the row the dashboard's Users-page grant writes
 * (`grantEntitlement`), with a reference that names it ours; no store state is
 * invented. `lib/entitlements.ts` cannot load outside Next (`server-only`), so
 * this is the one script allowed to write the table; the boundary test pins it
 * to `source: "grant"` and this reference.
 */
async function grantPlus(email: string, now: Date) {
  const refusal = plusCompRefusal(email)
  if (refusal) throw new Error(refusal)
  const user = await db.user.findUnique({ where: { email }, select: { id: true, suspended_at: true, deletedAt: true } })
  if (!user || user.deletedAt || user.suspended_at) throw new Error(`No live account at ${email}.`)
  const ref = `${PLUS_REF_PREFIX}${user.id}`
  const startsAt = new Date(now.getTime() - 60_000)
  const expiresAt = new Date(now.getTime() + COMP_DAYS * DAY_MS)
  await db.entitlements.upsert({
    where: { source_external_ref: { source: "grant", external_ref: ref } },
    update: { starts_at: startsAt, expires_at: expiresAt },
    create: { subject_kind: "user", subject_id: user.id, product: "plus", source: "grant", external_ref: ref, starts_at: startsAt, expires_at: expiresAt },
  })
  say(`  Blendn+ comp             ${email} until ${expiresAt.toISOString().slice(0, 10)}`)
}

/* -------------------------------------------------------------------------- */
/* --remove                                                                     */
/* -------------------------------------------------------------------------- */

async function remove(targets: Target[]) {
  const comps = await db.entitlements.deleteMany({ where: { source: "grant", external_ref: { startsWith: PLUS_REF_PREFIX } } })
  say(`  Blendn+ comps            ${comps.count} removed`)

  // The targets' own rows in the live rooms: sessions first (no tag of their own), then the tagged check-ins.
  const targetIds = targets.map((t) => t.id)
  if (targetIds.length) {
    await db.$executeRaw`
      DELETE FROM presence_sessions ps USING event_check_ins c
       WHERE ps.user_id = c.user_id AND ps.occurrence_id = c.occurrence_id
         AND c.user_id = ANY(${targetIds}::text[]) AND c.device_info->>'qaScale' = 'true'`
  }
  // The rooms they were in, and the targets' own chat memberships there (the crowd's go with the crowd): ids derived, so only ours.
  const roomEventIds = (await db.event_check_ins.findMany({ where: tagged, distinct: ["event_id"], select: { event_id: true } })).map((c) => c.event_id)
  const memberIds = roomEventIds.flatMap((eventId) => targetIds.map((userId) => roomMemberId(eventId, userId)))
  const targetMembers = await db.chat_group_members.deleteMany({ where: { id: { in: memberIds } } })
  say(`  target chat members      ${targetMembers.count} removed`)
  const checkIns = await db.event_check_ins.deleteMany({ where: tagged })
  say(`  tagged check-ins         ${checkIns.count} removed`)

  // Events in small batches, so the cascade (occurrences, RSVPs, sessions, rooms) never runs past a proxy's patience.
  // any-kind: the seed's venue days go with its events
  const eventIds = (await db.events.findMany({ where: { slug: { startsWith: EVENT_SLUG_PREFIX } }, select: { id: true } })).map((e) => e.id)
  for (const ids of slices(eventIds, REMOVE_EVENTS_AT_A_TIME)) {
    // any-kind: ids this seed made, venue days included
    await db.events.deleteMany({ where: { id: { in: ids } } })
  }
  say(`  events                   ${eventIds.length} removed`)
  const venues = await db.venues.deleteMany({ where: { source: VENUE_SOURCE } })
  say(`  venue                    ${venues.count} removed`)

  const userIds = await crowdUserIds()
  for (const ids of slices(userIds, REMOVE_USERS_AT_A_TIME)) await db.user.deleteMany({ where: { id: { in: ids } } })
  say(`  crowd users              ${userIds.length} removed (their friendships, requests, DMs, check-ins, RSVPs, chat memberships and posts with them)`)
  const rooms = await db.chat_groups.findMany({ where: { event_id: { in: roomEventIds } }, select: { id: true } })
  await recountMembers(rooms.map((r) => r.id))
  say(`  rooms                    ${rooms.length} member counts reset (a room the seed made stays, empty)`)
}

/* -------------------------------------------------------------------------- */
/* main                                                                         */
/* -------------------------------------------------------------------------- */

async function main() {
  const refusal = environmentRefusal(process.env)
  if (refusal) {
    console.error(`REFUSING: ${refusal}`)
    process.exitCode = 1
    return
  }
  if (APPLY && REMOVE) {
    console.error("REFUSING: --apply and --remove together; pick one.")
    process.exitCode = 1
    return
  }
  if (PLUS_EMAILS.length && !APPLY) {
    console.error("REFUSING: --grant-plus writes, so it needs --apply.")
    process.exitCode = 1
    return
  }

  const host = (() => {
    try {
      const url = new URL(process.env.DATABASE_URL ?? "")
      return `${url.host}${url.pathname}`
    } catch {
      return "(unparseable DATABASE_URL)"
    }
  })()
  const now = new Date()
  say(`\ndatabase: ${host}`)
  say(`mode:     ${APPLY ? "APPLY: this will write" : REMOVE ? "REMOVE: this will delete what the seed made" : "dry run"}\n`)

  const targets = await findTargets()
  for (const email of TARGET_EMAILS) if (!targets.some((t) => t.email === email)) say(`  !  ${email} does not exist here: skipped (this never creates it)`)
  if (targets.length === 0 && !REMOVE) {
    console.error("REFUSING: none of the target accounts exist in this database.")
    process.exitCode = 1
    return
  }

  if (REMOVE) {
    await remove(targets)
    say("\nWhat is left:")
    await readBack(targets, now)
    return
  }

  if (!APPLY) {
    const c = plannedCounts(targets.length)
    say(`Would write, for ${targets.length} target${targets.length === 1 ? "" : "s"}:`)
    say(`  ${c.crowdUsers} crowd users (qa.scale.NNNN@blendn.app, ids ${ID_PREFIX}NNNN), ${PER_TARGET.friends} friends each`)
    say(`  rooms: each target and ${PER_TARGET.bigRoomFriends} friends, plus ${ROOM_STRANGERS} strangers, in the first live event; ${PER_TARGET.secondRoomFriends} friends each in the second; every one of them a chat member of that room`)
    say(`  banter: ${PER_TARGET.friendDms} friend DMs + ${PER_TARGET.ratedNights * PER_TARGET.matchesPerNight} matches to rate + ${PER_TARGET.messageRequests} message requests each; ${PER_TARGET.friendRequests} friend requests each`)
    say(`  going: ${PER_TARGET.goingEvents} coming up at one venue, ${PER_TARGET.pastNights} past nights attended, ${PER_TARGET.visits} visits; ${c.boardPosts} board posts on an event whose doors are ahead`)
    const live = await liveEvents(now)
    say(live.length >= 2 ? `\nRooms would go in: ${live[0].slug} (big) and ${live[1].slug}` : `\n!  ${live.length} live event(s): --apply needs two`)
    for (const email of PLUS_EMAILS) say(`  Blendn+ comp for ${email}`)
    say("\nWhat is there now:")
    await readBack(targets, now)
    say("\nRe-run with --apply to write.\n")
    return
  }

  await apply(targets, now)
  for (const email of PLUS_EMAILS) await grantPlus(email, now)
  say("\nRead back:")
  await readBack(targets, now)
  say("")
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
