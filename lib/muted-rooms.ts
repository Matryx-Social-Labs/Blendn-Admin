import { Prisma } from "@prisma/client"

import { isUuid } from "./api-input"
import {
  buildChatRows,
  doorArgs,
  eventMemberArgs,
  EVENT_ROOM_WHERE,
  eventRowsWithEvent,
  LISTED_MEMBER_STATUSES,
  liveRoomsOnly,
  openRooms,
  otherMemberArgs,
  OTHER_ROOM_WHERE,
} from "./chat-group-rows"
import { blockCounterparties } from "./conversations"
import { db } from "./db"
import { mutedNowSql } from "./room-mute"

/**
 * The rooms a person silenced (`GET /me/muted-rooms`, and the `mutedRooms`
 * count on `GET /me/notification-preferences`).
 *
 * Which rooms: the person's member rows with a mute in force now
 * (`mutedNowSql`, read through the partial index `chat_group_members_muted_idx`),
 * and then the chat list's own rules (`lib/chat-group-rows.ts`): a live room,
 * and for a crew's or Blend's the owner's door as it stands now. A room that
 * fails them is not listed and not counted, so the count and the list agree.
 *
 * Paged by a keyset on `(updated_at DESC, chat_group_id)`: `updated_at` is when
 * the member row last changed, and a mute writes it, so the room muted last
 * comes first. The cursor carries the timestamp as Postgres prints it, to the
 * microsecond; a millisecond Date would skip or repeat rows that tie.
 */
export const MUTED_ROOMS_DEFAULT_LIMIT = 50
export const MUTED_ROOMS_MAX_LIMIT = 100
/** The count stops here; the app shows "999+" (`mutedRooms`). */
export const MUTED_ROOMS_COUNT_CAP = 1000
/**
 * How a read walks the candidates: `batch` at a time, and no more than
 * `maxExamined` before it answers with what it has and a cursor to go on from.
 * A person with thousands of muted rooms that are over must not make one
 * request read them all. Tests shrink both to reach the second batch.
 */
export interface WalkOptions {
  batch: number
  maxExamined: number
}
const WALK: WalkOptions = { batch: 200, maxExamined: 2000 }

interface Candidate {
  id: string
  /** `updated_at` as Postgres prints it, UTC, microseconds. */
  ts: string
}

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

export const encodeMutedCursor = (c: Candidate): string => Buffer.from(`${c.ts}|${c.id}`).toString("base64url")

/** The cursor an earlier answer gave, or null for anything that is not one. */
export function decodeMutedCursor(raw: string): Candidate | null {
  const [ts, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|")
  return rest.length === 0 && TS.test(ts ?? "") && isUuid(id) && encodeMutedCursor({ ts, id }) === raw ? { ts, id } : null
}

async function candidatesAfter(userId: string, now: Date, after: Candidate | null, take: number): Promise<Candidate[]> {
  const past = after
    ? Prisma.sql`AND (m.updated_at < ${after.ts}::timestamptz OR (m.updated_at = ${after.ts}::timestamptz AND m.chat_group_id > ${after.id}::uuid))`
    : Prisma.empty
  return db.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT m.chat_group_id AS id,
           to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
    FROM chat_group_members m
    WHERE m.user_id = ${userId}
      AND m.status IN ('active', 'muted')
      AND ${mutedNowSql(now)}
      ${past}
    ORDER BY m.updated_at DESC, m.chat_group_id ASC
    LIMIT ${take}
  `)
}

/** Which of these the chat list would list for this person: a live room, through its owner's door. */
async function listedAmong(userId: string, now: Date, ids: string[]): Promise<Set<string>> {
  const where = { user_id: userId, status: { in: [...LISTED_MEMBER_STATUSES] }, chat_group_id: { in: ids } }
  const [events, others] = await Promise.all([
    db.chat_group_members.findMany({
      where: { ...where, chat_group: EVENT_ROOM_WHERE, ...liveRoomsOnly(now) },
      select: { chat_group_id: true },
    }),
    db.chat_group_members.findMany({ where: { ...where, chat_group: OTHER_ROOM_WHERE }, ...doorArgs(userId) }),
  ])
  return new Set([...events, ...openRooms(others, userId)].map((m) => m.chat_group_id))
}

/**
 * The first `want` listed muted rooms after `after`, newest first. `resume` is
 * where to go on from when it stopped short of `want` only because it hit
 * `walk.maxExamined` (a person with thousands of muted rooms that are over).
 */
async function listedMuted(userId: string, now: Date, want: number, after: Candidate | null, walk: WalkOptions = WALK) {
  const kept: Candidate[] = []
  let cursor = after
  let examined = 0
  while (kept.length < want) {
    const batch = await candidatesAfter(userId, now, cursor, walk.batch)
    if (batch.length === 0) break
    const listed = await listedAmong(userId, now, batch.map((c) => c.id))
    for (const c of batch) if (listed.has(c.id) && kept.length < want) kept.push(c)
    examined += batch.length
    cursor = batch[batch.length - 1]
    if (batch.length < walk.batch) break
    if (kept.length < want && examined >= walk.maxExamined) return { kept, resume: cursor }
  }
  return { kept, resume: null }
}

/** How many rooms the person has silenced, up to `MUTED_ROOMS_COUNT_CAP`. */
export async function mutedRoomCount(userId: string, now: Date = new Date(), cap: number = MUTED_ROOMS_COUNT_CAP): Promise<number> {
  return (await listedMuted(userId, now, cap, null)).kept.length
}

/** One page of the rooms the person silenced, each row as a `GET /chat/groups` row. */
export async function mutedRoomPage(userId: string, limit: number, after: Candidate | null, now: Date = new Date(), walk: WalkOptions = WALK) {
  const { kept, resume } = await listedMuted(userId, now, limit + 1, after, walk)
  const page = kept.slice(0, limit)
  const more = kept.length > limit
  const nextCursor = more ? encodeMutedCursor(page[limit - 1]) : resume ? encodeMutedCursor(resume) : null
  if (page.length === 0) return { rooms: [], nextCursor }

  const blockedIds = await blockCounterparties(userId)
  const notUnread = [...blockedIds, userId]
  const unreadMessages = { deleted_at: null, user_id: { notIn: notUnread } }
  const where = { user_id: userId, status: { in: [...LISTED_MEMBER_STATUSES] }, chat_group_id: { in: page.map((c) => c.id) } }
  const [eventRows, otherRows] = await Promise.all([
    db.chat_group_members.findMany({ where: { ...where, chat_group: EVENT_ROOM_WHERE, ...liveRoomsOnly(now) }, ...eventMemberArgs(unreadMessages) }),
    db.chat_group_members.findMany({ where: { ...where, chat_group: OTHER_ROOM_WHERE }, ...otherMemberArgs(userId, unreadMessages) }),
  ])
  const built = await buildChatRows({
    userId,
    memberships: eventRowsWithEvent(eventRows),
    others: openRooms(otherRows, userId),
    notUnread,
    blockedIds,
    now,
  })
  const byId = new Map<string, (typeof built.groups)[number] | (typeof built.rooms)[number]>(
    [...built.groups, ...built.rooms].map((r) => [r.id, r])
  )
  // The page's own order; a room that went between the two reads is simply not there.
  return { rooms: page.flatMap((c) => byId.get(c.id) ?? []), nextCursor }
}
