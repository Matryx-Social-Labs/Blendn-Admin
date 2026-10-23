import type { Prisma } from "@prisma/client"
import {
  BOARD_LINES,
  BOARD_POSTS,
  CHECK_IN_TAG,
  DM_LINES,
  EVENT_SLUG_PREFIX,
  PER_TARGET,
  REQUEST_LINES,
  VENUE_SOURCE,
  canonicalPair,
  crowdId,
  friendSlices,
  listableFriends,
  personFor,
  uuidFor,
  type Layout,
  type Person,
} from "./seed-qa-scale-plan"

/**
 * The rows of the scale world, as plain arrays: no database, so a test can
 * check every CHECK-shaped rule (canonical pairs, no self-edges, one open
 * check-in per person) before a single row is written.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const ago = (now: Date, ms: number) => new Date(now.getTime() - ms)

export interface Portraits {
  woman: string[]
  man: string[]
}

export interface Target {
  id: string
  email: string
}

/** An event the seed does not own: a live seeded one the rooms are put in. */
export interface LiveRoom {
  eventId: string
  occurrenceId: string
}

/* -------------------------------------------------------------------------- */
/* The crowd                                                                   */
/* -------------------------------------------------------------------------- */

const photoUrl = (id: string) => `https://images.unsplash.com/${id}?w=800&h=800&fit=crop&crop=faces&q=80&fm=jpg`
const blurUrl = (id: string) => `https://images.unsplash.com/${id}?w=400&h=400&fit=crop&crop=faces&q=60&fm=jpg&blur=120`

export function crowdRows(layout: Layout, portraits: Portraits, now: Date, leafCategoryIds: readonly string[]) {
  const listable = listableFriends(layout)
  const people: Person[] = Array.from({ length: layout.size }, (_, i) => personFor(i))
  const users: Prisma.UserCreateManyInput[] = []
  const profiles: Prisma.profilesCreateManyInput[] = []
  const interests: Prisma.user_interestsCreateManyInput[] = []

  for (const p of people) {
    const pool = portraits[p.gender]
    const photoId = pool[p.portrait % pool.length]
    const joined = ago(now, (30 + (p.index % 300)) * DAY)
    users.push({ id: p.id, email: p.email, name: p.name, image: photoUrl(photoId), role: "attendee", emailVerified: joined, createdAt: joined })
    profiles.push({
      id: p.id,
      name: p.name,
      age: p.age,
      date_of_birth: new Date(Date.UTC(now.getUTCFullYear() - p.age - 1, p.index % 12, 1 + (p.index % 27))),
      location: `${p.area}, Bengaluru`,
      bio: `Synthetic QA person ${p.id}. Likes ${p.interests.join(", ").toLowerCase()}.`,
      occupation: "QA scale crowd",
      interests: p.interests,
      photos: [photoUrl(photoId)],
      blur_photo: blurUrl(photoId),
      onboarded: true,
      intent_default: p.intents as ("friendship" | "networking" | "dating" | "just_here")[],
      gender: p.gender,
      interested_in: ["woman", "man"],
      orientations: ["bisexual"],
      show_online: true,
      // Only the people Friends here may list. Everyone else is a friend who did not opt in (or a stranger).
      friends_see_me_in_rooms: listable.has(p.index),
      created_at: joined,
    })
    if (leafCategoryIds.length >= 3) {
      for (const k of [0, 7, 19]) interests.push({ user_id: p.id, category_id: leafCategoryIds[(p.index * 3 + k) % leafCategoryIds.length] })
    }
  }
  return { users, profiles, interests }
}

/* -------------------------------------------------------------------------- */
/* Social graph                                                                */
/* -------------------------------------------------------------------------- */

export function socialRows(layout: Layout, targets: readonly Target[], now: Date) {
  const friendships: Prisma.friendshipsCreateManyInput[] = []
  const friendRequests: Prisma.friend_requestsCreateManyInput[] = []
  const messageRequests: Prisma.message_requestsCreateManyInput[] = []

  targets.forEach((target, t) => {
    const lay = layout.targets[t]
    lay.friends.forEach((index, k) => {
      const [user1_id, user2_id] = canonicalPair(target.id, crowdId(index))
      friendships.push({ id: uuidFor(`friendship:${target.id}:${index}`), user1_id, user2_id, created_at: ago(now, (3 + k) * DAY * 0.4) })
    })
    lay.friendRequesters.forEach((index, k) => {
      friendRequests.push({
        id: uuidFor(`friend-request:${index}:${target.id}`),
        sender_id: crowdId(index),
        recipient_id: target.id,
        created_at: ago(now, (k + 1) * 47 * MINUTE),
      })
    })
    lay.messageRequesters.forEach((index, k) => {
      messageRequests.push({
        id: uuidFor(`message-request:${index}:${target.id}`),
        sender_id: crowdId(index),
        recipient_id: target.id,
        status: "pending",
        message: REQUEST_LINES[k % REQUEST_LINES.length],
        created_at: ago(now, (k + 1) * 53 * MINUTE),
        updated_at: ago(now, (k + 1) * 53 * MINUTE),
      })
    })
  })
  return { friendships, friendRequests, messageRequests }
}

/* -------------------------------------------------------------------------- */
/* Banter: friend DMs and the matches of past nights                           */
/* -------------------------------------------------------------------------- */

const PSEUDONYMS = ["Heron", "Otter", "Falcon", "Lynx", "Marten", "Plover", "Ibex", "Wren", "Civet", "Stork", "Gecko", "Tern"] as const
const MESSAGES_PER_THREAD = 4

export function pastNightSlug(n: number) {
  return `${EVENT_SLUG_PREFIX}night-${String(n).padStart(2, "0")}`
}

export function banterRows(layout: Layout, targets: readonly Target[], now: Date) {
  const conversations: Prisma.private_conversationsCreateManyInput[] = []
  const messages: Prisma.private_messagesCreateManyInput[] = []

  const thread = (key: string, target: string, peer: string, at: Date, fromPeer: boolean) => {
    const id = uuidFor(`conv:${key}`)
    for (let m = 0; m < MESSAGES_PER_THREAD; m++) {
      // Oldest first; the newest is the peer's, unread, so the row carries a badge.
      const sentByPeer = (m % 2 === 1) === fromPeer
      messages.push({
        id: uuidFor(`msg:${key}:${m}`),
        conversation_id: id,
        sender_id: sentByPeer ? peer : target,
        message_text: DM_LINES[(m + key.length) % DM_LINES.length],
        is_read: !(sentByPeer && m >= MESSAGES_PER_THREAD - 2),
        created_at: new Date(at.getTime() - (MESSAGES_PER_THREAD - m) * 3 * MINUTE),
        updated_at: new Date(at.getTime() - (MESSAGES_PER_THREAD - m) * 3 * MINUTE),
      })
    }
    return id
  }

  targets.forEach((target, t) => {
    const lay = layout.targets[t]
    friendSlices(lay.friends).dm.forEach((index, k) => {
      const peer = crowdId(index)
      const at = ago(now, (k + 1) * 37 * MINUTE)
      const id = thread(`${target.id}:${peer}`, target.id, peer, at, true)
      const [user1_id, user2_id] = canonicalPair(target.id, peer)
      conversations.push({
        id,
        user1_id,
        user2_id,
        user1_revealed: true,
        user2_revealed: true,
        origin_friendship: true,
        last_message_at: at,
        created_at: ago(now, (k + 10) * DAY),
        updated_at: at,
      })
    })

    // The people matched with at the first nights: what Rate walks through, "1 of 6".
    lay.matchPeers.forEach((group, night) => {
      group.forEach((index, k) => {
        const peer = crowdId(index)
        const at = ago(now, (night * 2 + 1) * DAY + (k + 1) * 11 * MINUTE)
        const id = thread(`${target.id}:${peer}`, target.id, peer, at, true)
        const [user1_id, user2_id] = canonicalPair(target.id, peer)
        const mine = (side: string) => (side === target.id ? PSEUDONYMS[(night + k) % PSEUDONYMS.length] : PSEUDONYMS[(night + k + 5) % PSEUDONYMS.length])
        conversations.push({
          id,
          user1_id,
          user2_id,
          user1_pseudonym: mine(user1_id),
          user2_pseudonym: mine(user2_id),
          origin_event_id: uuidFor(`event:${pastNightSlug(night + 1)}`),
          last_message_at: at,
          created_at: at,
          updated_at: at,
        })
      })
    })
  })
  return { conversations, messages }
}

/* -------------------------------------------------------------------------- */
/* Events: the venue, the nights past and coming, the visits                   */
/* -------------------------------------------------------------------------- */

const BENGALURU = { lat: 12.9716, lng: 77.5946 }
export const QA_VENUE_ID = uuidFor("venue")

export const upcomingSlug = (n: number) => `${EVENT_SLUG_PREFIX}soon-${String(n).padStart(2, "0")}`
export const visitSlug = (n: number) => `${EVENT_SLUG_PREFIX}visit-${String(n).padStart(2, "0")}`

/** Midnight UTC of a day: `occurs_on`, which is the local date (the nights below start at 18:30 and 06:00 IST, the same UTC date). */
const dateOnly = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

function atUtc(now: Date, dayOffset: number, hour: number, minute: number): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hour, minute))
  return d
}

export function venueRow(): Prisma.venuesCreateInput {
  return {
    id: QA_VENUE_ID,
    name: "QA Scale Hall",
    address: "1 Test Road, Indiranagar",
    city: "Bengaluru",
    latitude: BENGALURU.lat,
    longitude: BENGALURU.lng,
    venue_type: "other",
    area: "Indiranagar",
    source: VENUE_SOURCE,
    status: "active",
  }
}

interface EventSpec {
  slug: string
  title: string
  start: Date
  end: Date
  kind: "event" | "venue_day"
  status: "published" | "completed"
}

/** 18:30 IST start, 3 hours: past nights, then the coming ones; 06:00 IST to 06:00 for each visit's venue day. */
export function eventSpecs(now: Date): EventSpec[] {
  const p = PER_TARGET
  const night = (offset: number) => ({ start: atUtc(now, offset, 13, 0), end: atUtc(now, offset, 16, 0) })
  const past = Array.from({ length: p.pastNights }, (_, i): EventSpec => ({
    slug: pastNightSlug(i + 1),
    title: `QA Scale night ${i + 1}`,
    ...night(-(2 * i + 1)),
    kind: "event",
    status: "completed",
  }))
  const upcoming = Array.from({ length: p.goingEvents }, (_, i): EventSpec => ({
    slug: upcomingSlug(i + 1),
    title: `QA Scale coming up ${i + 1}`,
    ...night(i + 1),
    kind: "event",
    status: "published",
  }))
  const visits = Array.from({ length: p.visits }, (_, i): EventSpec => ({
    slug: visitSlug(i + 1),
    title: `Venue day · QA Scale Hall · visit ${i + 1}`,
    start: atUtc(now, -(3 * i + 1), 0, 30),
    end: atUtc(now, -(3 * i), 0, 30),
    kind: "venue_day",
    status: "published",
  }))
  return [...past, ...upcoming, ...visits]
}

export function eventRows(now: Date, hostId: string, systemUserId: string) {
  const specs = eventSpecs(now)
  const events: Prisma.eventsCreateManyInput[] = specs.map((s) => ({
    id: uuidFor(`event:${s.slug}`),
    slug: s.slug,
    title: s.title,
    description: "Synthetic event for scale testing. Made by seed-qa-scale; safe to delete.",
    short_description: "Synthetic QA event",
    venue_id: QA_VENUE_ID,
    venue_name: "QA Scale Hall",
    address: "1 Test Road, Indiranagar",
    city: "Bengaluru",
    country: "India",
    latitude: BENGALURU.lat,
    longitude: BENGALURU.lng,
    start_time: s.start,
    end_time: s.end,
    timezone: "Asia/Kolkata",
    status: s.status,
    // A venue day is unlisted, owned by the system user, and has no organisation (events_venue_day_shape).
    visibility: s.kind === "venue_day" ? "unlisted" : "public",
    kind: s.kind,
    organizer_id: s.kind === "venue_day" ? systemUserId : hostId,
    created_at: ago(now, 90 * DAY),
  }))
  const occurrences: Prisma.event_occurrencesCreateManyInput[] = specs.map((s) => ({
    id: uuidFor(`occurrence:${s.slug}`),
    event_id: uuidFor(`event:${s.slug}`),
    occurs_on: dateOnly(s.start),
    start_time: s.start,
    end_time: s.end,
  }))
  return { specs, events, occurrences }
}

/* -------------------------------------------------------------------------- */
/* Going history, visits, ratings                                              */
/* -------------------------------------------------------------------------- */

export function historyRows(layout: Layout, targets: readonly Target[], now: Date) {
  const specs = eventSpecs(now)
  const rsvps: Prisma.event_rsvpsCreateManyInput[] = []
  const checkIns: Prisma.event_check_insCreateManyInput[] = []
  const sessions: Prisma.presence_sessionsCreateManyInput[] = []

  const attended = (userId: string, spec: EventSpec, arriveAfter: number, stayFor: number) => {
    const occ = uuidFor(`occurrence:${spec.slug}`)
    const arrived = new Date(spec.start.getTime() + arriveAfter)
    const left = new Date(arrived.getTime() + stayFor)
    checkIns.push({
      id: uuidFor(`checkin:${occ}:${userId}`),
      event_id: uuidFor(`event:${spec.slug}`),
      occurrence_id: occ,
      user_id: userId,
      kind: "attendee",
      status: "checked_out",
      check_in_time: arrived,
      check_out_time: left,
      last_seen_at: left,
      device_info: CHECK_IN_TAG,
      // A venue day's visit is a Go Live window: it ended.
      ...(spec.kind === "venue_day" && { expires_at: left }),
    })
    sessions.push({
      id: uuidFor(`session:${occ}:${userId}`),
      event_id: uuidFor(`event:${spec.slug}`),
      occurrence_id: occ,
      user_id: userId,
      kind: "attendee",
      arrived_at: arrived,
      departed_at: left,
      departed_source: "user",
      last_seen_at: left,
      source: "polling",
    })
  }

  targets.forEach((target, t) => {
    specs.forEach((spec, i) => {
      if (spec.kind === "event") {
        rsvps.push({
          id: uuidFor(`rsvp:${spec.slug}:${target.id}`),
          event_id: uuidFor(`event:${spec.slug}`),
          user_id: target.id,
          status: "going",
          created_at: ago(now, (i + 1) * 3 * HOUR),
        })
      }
      if (spec.status === "completed") attended(target.id, spec, 20 * MINUTE, 2 * HOUR)
      if (spec.kind === "venue_day") attended(target.id, spec, 12 * HOUR, 100 * MINUTE)
    })
    // The people the target matched with were at those nights too.
    layout.targets[t].matchPeers.forEach((group, night) => {
      const spec = specs[night]
      for (const index of group) attended(crowdId(index), spec, 25 * MINUTE, 90 * MINUTE)
    })
  })
  return { rsvps, checkIns, sessions }
}

/* -------------------------------------------------------------------------- */
/* The rooms                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Who is checked in to the two live events: every target and their first 60
 * friends and 300 strangers in the big one; each target's next 4 friends in the
 * second. One open check-in each, so the partial unique index never fires.
 * `skip` is the `occurrence:person` pairs somebody else already owns a row for.
 */
export function roomRows(layout: Layout, targets: readonly Target[], now: Date, big: LiveRoom, second: LiveRoom, skip: ReadonlySet<string> = new Set()) {
  const checkIns: Prisma.event_check_insCreateManyInput[] = []
  const sessions: Prisma.presence_sessionsCreateManyInput[] = []

  const enter = (room: LiveRoom, userId: string, k: number) => {
    if (skip.has(`${room.occurrenceId}:${userId}`)) return
    const arrived = ago(now, (3 + ((k * 7) % 40)) * MINUTE)
    checkIns.push({
      id: uuidFor(`checkin:${room.occurrenceId}:${userId}`),
      event_id: room.eventId,
      occurrence_id: room.occurrenceId,
      user_id: userId,
      kind: "attendee",
      status: "checked_in",
      check_in_time: arrived,
      last_seen_at: now,
      device_info: CHECK_IN_TAG,
    })
    sessions.push({
      id: uuidFor(`session:${room.occurrenceId}:${userId}`),
      event_id: room.eventId,
      occurrence_id: room.occurrenceId,
      user_id: userId,
      kind: "attendee",
      arrived_at: arrived,
      last_seen_at: now,
      source: "polling",
    })
  }

  targets.forEach((target, t) => {
    const slices = friendSlices(layout.targets[t].friends)
    enter(big, target.id, t)
    slices.bigRoom.forEach((index, k) => enter(big, crowdId(index), k))
    slices.secondRoom.forEach((index, k) => enter(second, crowdId(index), k))
  })
  layout.strangers.forEach((index, k) => enter(big, crowdId(index), k))
  return { checkIns, sessions }
}

/**
 * Who is in an event's chat room, as `lib/check-in-core.ts` `seatInRoom` leaves them: the same
 * `chat_group_members` row a real check-in creates (a member, active, no Go Live cut-off, a handle).
 * The id is derived from the event and the person, so `--remove` can find a target's row among
 * rows that are not ours, and a re-run meets the row it made.
 *
 * `handle(userId, attempt)` is the pseudonym derivation, injected so this stays free of the library
 * (which opens a database client): attempt 0 is the person's own, the next ones are the retries a
 * collision with `taken` (the handles already in the room) calls for.
 */
export function roomMemberRows(
  chatGroupId: string,
  eventId: string,
  userIds: readonly string[],
  handle: (userId: string, attempt: number) => string,
  taken: ReadonlySet<string> = new Set()
) {
  const used = new Set(taken)
  return userIds.map((userId): Prisma.chat_group_membersCreateManyInput => {
    let attempt = 0
    let anonymous_name = handle(userId, attempt)
    while (used.has(anonymous_name)) anonymous_name = handle(userId, ++attempt)
    used.add(anonymous_name)
    return {
      id: roomMemberId(eventId, userId),
      chat_group_id: chatGroupId,
      user_id: userId,
      role: "member",
      status: "active",
      last_allowed_at: null,
      anonymous_name,
    }
  })
}

export const roomMemberId = (eventId: string, userId: string) => uuidFor(`member:${eventId}:${userId}`)

/** The posts of the board: on an event whose doors have not opened, because the board closes at doors. */
export function boardRows(layout: Layout, big: Pick<LiveRoom, "eventId">, now: Date) {
  const posts: Prisma.board_postsCreateManyInput[] = []
  for (let i = 0; i < BOARD_POSTS; i++) {
    const [kind, body] = BOARD_LINES[i % BOARD_LINES.length]
    const created = ago(now, (i + 1) * 3 * MINUTE)
    posts.push({
      id: uuidFor(`board:${i}`),
      event_id: big.eventId,
      author_id: crowdId(layout.strangers[i % layout.strangers.length]),
      kind,
      body: `${body} (#${i + 1})`,
      spaces_left: kind === "offer" ? 1 + (i % 3) : null,
      created_at: created,
      updated_at: created,
    })
  }
  return posts
}
