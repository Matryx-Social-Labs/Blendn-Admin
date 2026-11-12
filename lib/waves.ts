import { Prisma } from "@prisma/client"

import { chatWindowState } from "@/lib/chat-window"
import { firstName } from "@/lib/conversation-identity"
import { closedPairKeys } from "@/lib/conversations"
import { db } from "@/lib/db"
import { createdBefore, decodeKeyset, keysetPage, NEWEST_FIRST } from "@/lib/pagination"
import { pseudonymsForEvent } from "@/lib/anonymous-names"
import { logCapHit } from "@/lib/rate-limit"
import { hit } from "@/lib/rate-limit-store"
import { roomHandle } from "@/lib/room-handle"
import { notHostBannedFrom } from "@/lib/room-kind"
import { LISTED_IN_ROSTER, notStrangersTo } from "@/lib/room-people"
import { visibleInRoom } from "@/lib/identity"

/**
 * Recorded waves (SCRUM-1042; owner ruling 2026-11-12, Wave replaces Like for
 * people). The rules live here; `POST /events/:id/waves` orders the refusals.
 *
 * - One wave per sender → recipient per room, never re-sent (W1, the unique key).
 * - Two in a room, either way, open the anonymous conversation
 *   (`openIfMutual` in lib/matches.ts). An `event_likes` row from before counts
 *   there as a hidden wave and is never listed (approval 11).
 * - The sender caps (W3-W6) count these rows, not a Redis counter (W9), so they
 *   hold across instances and through a Redis outage, and a refused wave never
 *   counts because it was never stored.
 *
 * Person to person only. Crew waves are their own PR (flow-5-build.md § hook points).
 */

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** Anti-spam W3-W6 (anti-spam.md § OWNER APPROVED 2026-11-12). */
export const WAVE_LIMITS = {
  /** W3: waves one person may send in one room per rolling hour. */
  ROOM_PER_HOUR: 20,
  /** W4: waves one person may send per rolling day, every room. */
  PER_DAY: 60,
  /** W5: an account younger than this is new. */
  NEW_ACCOUNT_MS: DAY_MS,
  /** W5: a new account's per-room hourly ceiling. */
  NEW_ROOM_PER_HOUR: 5,
  /** W5: a new account's daily ceiling. */
  NEW_PER_DAY: 15,
  /** W6: this many unanswered waves in the last day slows the sender... */
  UNANSWERED_TO_SLOW: 20,
  /** W6: ...to this per room per hour, until some are answered or age out. */
  SLOWED_ROOM_PER_HOUR: 5,
} as const

/** Received waves per page (S-A "See all"). */
export const WAVES_PAGE = 20
/** At most this many rooms in the Banter summary: rooms close within a day of ending, so a person has a handful. */
const SUMMARY_ROOMS = 20

export interface WaveCap {
  cap: "room_hour" | "day"
  /** Seconds until one more wave would be accepted. */
  retryAfter: number
}

type Reader = Pick<Prisma.TransactionClient, "event_waves" | "user" | "$queryRaw">

/**
 * Whether this sender may wave once more in this room now, from their own
 * stored waves only. Reads nothing about any recipient (W8): a refusal here
 * says the same whoever they were waving at.
 */
export async function waveCapFor(fromId: string, eventId: string, now: Date = new Date(), client: Reader = db): Promise<WaveCap | null> {
  const since = new Date(now.getTime() - DAY_MS)
  const [user, sent, unanswered] = await Promise.all([
    client.user.findUnique({ where: { id: fromId }, select: { createdAt: true } }),
    // Bounded by the caps themselves: nobody stores more than PER_DAY in a day.
    client.event_waves.findMany({
      where: { from_id: fromId, created_at: { gt: since } },
      orderBy: { created_at: "desc" },
      select: { event_id: true, created_at: true },
      take: WAVE_LIMITS.PER_DAY + 1,
    }),
    // Unanswered: no wave back in that room, and no hidden like back either (a like back made it mutual).
    client.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM event_waves w
      WHERE w.from_id = ${fromId} AND w.created_at > ${since}
        AND NOT EXISTS (SELECT 1 FROM event_waves b WHERE b.event_id = w.event_id AND b.from_id = w.to_id AND b.to_id = w.from_id)
        AND NOT EXISTS (SELECT 1 FROM event_likes l WHERE l.event_id = w.event_id AND l.liker_id = w.to_id AND l.liked_id = w.from_id)`,
  ])
  const isNew = !user || now.getTime() - user.createdAt.getTime() < WAVE_LIMITS.NEW_ACCOUNT_MS
  const slowed = (unanswered[0]?.n ?? 0) >= WAVE_LIMITS.UNANSWERED_TO_SLOW
  const dayLimit = isNew ? WAVE_LIMITS.NEW_PER_DAY : WAVE_LIMITS.PER_DAY
  const roomLimit = isNew || slowed ? (isNew ? WAVE_LIMITS.NEW_ROOM_PER_HOUR : WAVE_LIMITS.SLOWED_ROOM_PER_HOUR) : WAVE_LIMITS.ROOM_PER_HOUR

  // Newest first, so the `limit`-th newest is the one that must age out before one more fits.
  const refusal = (rows: { created_at: Date }[], limit: number, windowMs: number) =>
    rows.length >= limit ? Math.max(1, Math.ceil((rows[limit - 1].created_at.getTime() + windowMs - now.getTime()) / 1000)) : null

  const day = refusal(sent, dayLimit, DAY_MS)
  if (day !== null) {
    await logDailyCapHit(fromId, dayLimit)
    return { cap: "day", retryAfter: day }
  }
  const hourAgo = now.getTime() - HOUR_MS
  const room = refusal(sent.filter((w) => w.event_id === eventId && w.created_at.getTime() > hourAgo), roomLimit, HOUR_MS)
  return room === null ? null : { cap: "room_hour", retryAfter: room }
}

/** `abuse.cap_hit` (`logCapHit`), once per user per day: the cap is a DB count, so the once is a store key. Never fails the refusal. */
async function logDailyCapHit(userId: string, cap: number): Promise<void> {
  try {
    const { count } = await hit(`abuse-log:wave:${userId}`, DAY_MS)
    if (count === 1) logCapHit(userId, "wave", cap)
  } catch {
    // A log line is not worth a failed request.
  }
}

/** Has `fromId` waved at `toId` in this room? A like is not a wave: this never reads `event_likes`. */
export async function hasWaved(eventId: string, fromId: string, toId: string): Promise<boolean> {
  const row = await db.event_waves.findUnique({
    where: { event_id_from_id_to_id: { event_id: eventId, from_id: fromId, to_id: toId } },
    select: { id: true },
  })
  return row !== null
}

export type RecordOutcome = { recorded: true } | { recorded: false; capped: WaveCap | null }

/**
 * Store the wave, under the sender's lock so two requests at once cannot both
 * pass the caps (re-checked here, after the early check the route makes before
 * looking at the recipient). A second wave at the same person here is
 * `recorded: false, capped: null`: no row, and the route answers it as sent.
 */
export async function recordWave(eventId: string, fromId: string, toId: string, now: Date = new Date()): Promise<RecordOutcome> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`waves:${fromId}`}, 0))`
    const capped = await waveCapFor(fromId, eventId, now, tx)
    if (capped) return { recorded: false, capped }
    const { count } = await tx.event_waves.createMany({
      data: [{ event_id: eventId, from_id: fromId, to_id: toId, created_at: now }],
      skipDuplicates: true,
    })
    return count === 1 ? { recorded: true } : { recorded: false, capped: null }
  })
}

/** Is this event's room still open (event end + window, or the venue day's reset)? Answering a wave lasts this long. */
export async function roomIsOpen(eventId: string, now: Date = new Date()): Promise<boolean> {
  const event = await db.events.findUnique({
    where: { id: eventId },
    select: { start_time: true, end_time: true, status: true, deleted_at: true, kind: true, chat_group: { select: { status: true } } },
  })
  if (!event) return false
  return chatWindowState(event, { status: event.chat_group?.status ?? "active" }, now).open
}

/**
 * Everybody whose waves `viewerId` must not see, whichever way: blocks both
 * ways, a pair that left each other, friends (never strangers), and anybody
 * the viewer reported. The deck's set (`matchesForEvent`).
 */
async function hiddenFrom(viewerId: string): Promise<string[]> {
  const [blocks, closed, friends, reported] = await Promise.all([
    db.blocked_users.findMany({
      where: { OR: [{ blocker_id: viewerId }, { blocked_id: viewerId }] },
      select: { blocker_id: true, blocked_id: true },
    }),
    closedPairKeys(viewerId),
    notStrangersTo(viewerId),
    db.user_reports.findMany({ where: { reporter_id: viewerId }, select: { reported_id: true }, distinct: ["reported_id"] }),
  ])
  return [
    ...new Set([
      ...blocks.map((b) => (b.blocker_id === viewerId ? b.blocked_id : b.blocker_id)),
      ...closed,
      ...friends,
      ...reported.map((r) => r.reported_id),
    ]),
  ]
}

/** The waves a viewer may see in one room: not from the hidden, the suspended, the unlisted or the banned. */
function visibleWhere(viewerId: string, eventId: string, hidden: string[]): Prisma.event_wavesWhereInput {
  return {
    event_id: eventId,
    to_id: viewerId,
    ...(hidden.length > 0 && { from_id: { notIn: hidden } }),
    from: {
      suspended_at: null,
      ...LISTED_IN_ROSTER,
      // Banned from this room by its host is not in it, as on the roster.
      ...notHostBannedFrom({ event_id: eventId }),
    },
  }
}

export interface ReceivedWave {
  /** Their handle in this room (`rh_…`), never the account id: Wave back, Block and Report take it. */
  userId: string
  /** The roster's rule: their pseudonym here, or their first name if they chose to be named in this room. */
  displayName: string
  wavedAt: string
  /** Whether you have answered it (your wave back, or a like of yours from before). */
  wavedBack: boolean
}

export interface ReceivedWaves {
  total: number
  waves: ReceivedWave[]
  nextCursor: string | null
}

/**
 * Who waved at `viewerId` in this room, newest first, paged. The caller has
 * already decided the viewer may read the room (`GET /events/:id/waves`).
 * `waitingOnly` drops the ones already answered (the Banter row).
 */
export async function receivedWaves(
  viewerId: string,
  eventId: string,
  opts: { cursor?: string | null; limit?: number; waitingOnly?: boolean } = {}
): Promise<ReceivedWaves | { refused: "bad_cursor" }> {
  const limit = opts.limit ?? WAVES_PAGE
  const after = opts.cursor ? decodeKeyset(opts.cursor) : null
  if (opts.cursor && !after) return { refused: "bad_cursor" }

  const hidden = await hiddenFrom(viewerId)
  const [mineOut, likedOut] = await Promise.all([
    db.event_waves.findMany({ where: { event_id: eventId, from_id: viewerId }, select: { to_id: true } }),
    db.event_likes.findMany({ where: { event_id: eventId, liker_id: viewerId }, select: { liked_id: true } }),
  ])
  const answered = new Set([...mineOut.map((w) => w.to_id), ...likedOut.map((l) => l.liked_id)])
  const base = visibleWhere(viewerId, eventId, opts.waitingOnly ? [...hidden, ...answered] : hidden)

  const [total, rows] = await Promise.all([
    db.event_waves.count({ where: base }),
    db.event_waves.findMany({
      where: after ? { AND: [base, createdBefore(after)] } : base,
      orderBy: NEWEST_FIRST,
      take: limit + 1,
      select: { id: true, from_id: true, created_at: true },
    }),
  ])
  const page = keysetPage(rows, limit, (r) => ({ at: r.created_at, id: r.id }))
  const names = await roomNamesFor(viewerId, eventId, page.items.map((r) => r.from_id))
  return {
    total,
    nextCursor: page.nextCursor,
    waves: page.items.map((r) => ({
      userId: roomHandle(eventId, r.from_id),
      displayName: names.get(r.from_id) ?? "Attendee",
      wavedAt: r.created_at.toISOString(),
      wavedBack: answered.has(r.from_id),
    })),
  }
}

/**
 * People as `viewerId` sees them in this room: the roster's rule
 * (`visibleInRoom`), a first name only for somebody who chose to be named
 * here, otherwise the pseudonym. "Attendee", never the real name, when a
 * pseudonym is missing.
 */
export async function roomNamesFor(viewerId: string, eventId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const [pseudonyms, visible] = await Promise.all([pseudonymsForEvent(eventId, ids), visibleInRoom(viewerId, eventId, ids)])
  const named = visible.size
    ? await db.user.findMany({ where: { id: { in: [...visible] } }, select: { id: true, name: true } })
    : []
  const nameOf = new Map(named.map((u) => [u.id, u.name?.trim() ? firstName(u.name.trim()) : null]))
  return new Map(ids.map((id) => [id, nameOf.get(id) || pseudonyms.get(id) || "Attendee"]))
}

export interface WaitingRoom {
  eventId: string
  /** How many waves here you have not answered. */
  waiting: number
  latest: ReceivedWave
}

/**
 * B-A, one pinned Banter row per room: every open room where somebody's wave
 * is waiting for you, with the count and the newest. Never a room `shut` to
 * you (one you run or host, or were banned from), nor one that has closed.
 */
export async function wavesWaiting(
  viewerId: string,
  shut: (eventId: string) => Promise<boolean>,
  now: Date = new Date()
): Promise<WaitingRoom[]> {
  const rooms = await db.event_waves.groupBy({
    by: ["event_id"],
    where: { to_id: viewerId },
    _max: { created_at: true },
    orderBy: { _max: { created_at: "desc" } },
    take: SUMMARY_ROOMS,
  })
  const out: WaitingRoom[] = []
  for (const { event_id } of rooms) {
    if (!(await roomIsOpen(event_id, now)) || (await shut(event_id))) continue
    const page = await receivedWaves(viewerId, event_id, { limit: 1, waitingOnly: true })
    if ("refused" in page || page.total === 0) continue
    out.push({ eventId: event_id, waiting: page.total, latest: page.waves[0] })
  }
  return out
}
