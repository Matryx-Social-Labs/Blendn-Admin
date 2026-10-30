import { Prisma } from "@prisma/client"

import { isUuid } from "./api-input"
import {
  buildChatRows,
  eventMemberArgs,
  EVENT_ROOM_WHERE,
  eventRowsWithEvent,
  LISTED_MEMBER_STATUSES,
  liveRoomsOnly,
} from "./chat-group-rows"
import { crewAndBlendRooms } from "./chat-list"
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
 * Paged by a keyset on `(muted_at DESC, chat_group_id)`: `muted_at` is when the
 * person muted the room (`withMute`), so the room muted last comes first and
 * nothing that merely touches the member row moves it: reading the room
 * writes `updated_at` and used to float it to the top, and out of a page the
 * client had already read. A mute from before `muted_at` falls back to
 * `updated_at`. The cursor carries that key, an ISO time to the millisecond.
 */
export const MUTED_ROOMS_DEFAULT_LIMIT = 50
export const MUTED_ROOMS_MAX_LIMIT = 100
/** The count stops here; the app shows "999+" (`mutedRooms`). */
export const MUTED_ROOMS_COUNT_CAP = 1000
/** Muted rooms the count looks at in all before it answers with what it has: a person with more that are over reads a lower bound. */
export const COUNT_MAX_EXAMINED = 10_000
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
  /** The mute's sort key (`mutedAtSql`): an ISO time to the millisecond, UTC. */
  ts: string
}

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export const encodeMutedCursor = (c: Candidate): string => Buffer.from(`${c.ts}|${c.id}`).toString("base64url")

/** The cursor an earlier answer gave, or null for anything that is not one. */
export function decodeMutedCursor(raw: string): Candidate | null {
  const [ts, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|")
  return rest.length === 0 && TS.test(ts ?? "") && isUuid(id) && encodeMutedCursor({ ts, id }) === raw ? { ts, id } : null
}

/**
 * When the person muted the room, as a string that sorts as time does: the
 * `muted_at` the mute wrote, else (a mute from before it existed) the member
 * row's `updated_at`, which a mute used to set and a read also moves.
 */
const mutedAtSql = Prisma.sql`COALESCE(m.notification_preferences->>'muted_at', to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`

async function candidatesAfter(userId: string, now: Date, after: Candidate | null, take: number): Promise<Candidate[]> {
  const past = after
    ? Prisma.sql`AND (${mutedAtSql} < ${after.ts} OR (${mutedAtSql} = ${after.ts} AND m.chat_group_id > ${after.id}::uuid))`
    : Prisma.empty
  return db.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT m.chat_group_id AS id, ${mutedAtSql} AS ts
    FROM chat_group_members m
    WHERE m.user_id = ${userId}
      AND m.status IN ('active', 'muted')
      AND ${mutedNowSql(now)}
      ${past}
    ORDER BY ts DESC, m.chat_group_id ASC
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
    crewAndBlendRooms(userId, { chat_group_id: { in: ids } }),
  ])
  return new Set([...events, ...others].map((m) => m.chat_group_id))
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
export async function mutedRoomCount(
  userId: string,
  now: Date = new Date(),
  cap: number = MUTED_ROOMS_COUNT_CAP,
  walk: WalkOptions = WALK
): Promise<number> {
  let counted = 0
  let after: Candidate | null = null
  // Follows `resume` as the list's cursor does, so the two agree; only the ceiling below ends it early.
  for (let examined = 0; examined < COUNT_MAX_EXAMINED && counted < cap; examined += walk.maxExamined) {
    const { kept, resume } = await listedMuted(userId, now, cap - counted, after, walk)
    counted += kept.length
    if (!resume) break
    after = resume
  }
  return counted
}

/** One page of the rooms the person silenced, each row as a `GET /chat/groups` row. */
export async function mutedRoomPage(userId: string, limit: number, after: Candidate | null, now: Date = new Date(), walk: WalkOptions = WALK) {
  const { kept, resume } = await listedMuted(userId, now, limit + 1, after, walk)
  const page = kept.slice(0, limit)
  const more = kept.length > limit
  const nextCursor = more ? encodeMutedCursor(page[limit - 1]) : resume ? encodeMutedCursor(resume) : null
  if (page.length === 0) return { rooms: [], nextCursor }

  const ids = { chat_group_id: { in: page.map((c) => c.id) } }
  const where = { user_id: userId, status: { in: [...LISTED_MEMBER_STATUSES] }, ...ids }
  const [blockedIds, eventRows, others] = await Promise.all([
    blockCounterparties(userId),
    db.chat_group_members.findMany({ where: { ...where, chat_group: EVENT_ROOM_WHERE, ...liveRoomsOnly(now) }, ...eventMemberArgs }),
    crewAndBlendRooms(userId, ids),
  ])
  const notUnread = [...blockedIds, userId]
  const built = await buildChatRows({
    userId,
    memberships: eventRowsWithEvent(eventRows),
    others,
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
