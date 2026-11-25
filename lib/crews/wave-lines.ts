// Relative imports throughout — see lib/conversations.ts.
import type { Prisma } from "@prisma/client"

import { db } from "../db"
import { SYSTEM_USER_ID } from "../event-kind"
import { roomMemberFromRef } from "../room-handle"

/**
 * The `crew_waved` lines of a crew's chat, as one reader gets them
 * (SCRUM-1110): whether the crew has answered each, and which of them come
 * from a crew that reader hid (`crew_hides`) and so are not theirs to read —
 * in the history, its quotes, the chat list's preview and unread count, and
 * on the socket. A hide is the hider's alone: crewmates keep every line.
 */

/** A `crew_waved` line's metadata, as `lib/crews/like.ts` writes it. `occurrenceId` since 2026-11-25. */
interface CrewWaved {
  eventId: string
  occurrenceId?: string
  fromCrewId?: string
  fromUserId?: string
}

function crewWavedOf(metadata: Prisma.JsonValue): CrewWaved | null {
  const m = metadata as (CrewWaved & { kind?: unknown }) | null
  return m && typeof m === "object" && m.kind === "crew_waved" && typeof m.eventId === "string" ? m : null
}

/**
 * The `crew_waved` lines from crews this person hid, in their crew chats (or
 * this one): message ids. One small read for the many who hid none.
 * ponytail: ids, then `NOT IN`; one wave per crew per night keeps them few.
 */
export async function hiddenWaveLineIds(userId: string, chatGroupId?: string): Promise<string[]> {
  const hidden = await db.crew_hides.findMany({ where: { user_id: userId }, select: { crew_id: true } })
  if (hidden.length === 0) return []
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT m.id
    FROM chat_group_members cgm
    JOIN chat_groups g ON g.id = cgm.chat_group_id AND g.kind = 'crew'
    JOIN chat_messages m ON m.chat_group_id = g.id
    WHERE cgm.user_id = ${userId}
      AND (${chatGroupId ?? null}::uuid IS NULL OR g.id = ${chatGroupId ?? null}::uuid)
      AND m.user_id = ${SYSTEM_USER_ID} AND m.type = 'system'
      AND m.metadata ->> 'kind' = 'crew_waved'
      AND m.metadata ->> 'fromCrewId' = ANY(${hidden.map((h) => h.crew_id)}::text[])`
  return rows.map((r) => r.id)
}

/** The members of this room who hid this crew: the ones its wave's live line is not sent to. */
export async function hidersInRoom(crewId: string, chatGroupId: string): Promise<string[]> {
  const rows = await db.crew_hides.findMany({
    where: { crew_id: crewId, user: { chat_group_memberships: { some: { chat_group_id: chatGroupId } } } },
    select: { user_id: true },
  })
  return rows.map((r) => r.user_id)
}

/**
 * Which of these lines are `crew_waved` and whether `crewId`, whose chat they
 * are in, has answered: message id → answered; any other line is absent. A
 * line is only written for a wave nobody had met, so the crew's wave or like
 * back is what made a Mix of the pair that night: the Mix is the answer, open
 * or over. A line from before `occurrenceId` is matched by its event.
 */
export async function answeredWaves(
  crewId: string | null,
  viewerId: string,
  lines: readonly { id: string; type: string; metadata: Prisma.JsonValue }[]
): Promise<Map<string, boolean>> {
  const waved = lines.flatMap((l) => {
    const wave = l.type === "system" ? crewWavedOf(l.metadata) : null
    return wave ? [{ id: l.id, wave }] : []
  })
  if (!crewId || waved.length === 0) return new Map()
  const mixes = await db.blends.findMany({
    where: {
      OR: [{ a_crew_id: crewId }, { b_crew_id: crewId }],
      occurrence: { event_id: { in: [...new Set(waved.map((w) => w.wave.eventId))] } },
    },
    select: { occurrence_id: true, a_crew_id: true, b_crew_id: true, b_user_id: true, occurrence: { select: { event_id: true } } },
  })
  return new Map(
    waved.map(({ id, wave }) => {
      const waverId = wave.fromUserId ? roomMemberFromRef(wave.eventId, wave.fromUserId, viewerId) : null
      const answered = mixes.some(
        (mix) =>
          (wave.occurrenceId ? mix.occurrence_id === wave.occurrenceId : mix.occurrence.event_id === wave.eventId) &&
          (wave.fromCrewId
            ? mix.a_crew_id === wave.fromCrewId || mix.b_crew_id === wave.fromCrewId
            : waverId !== null && mix.b_user_id === waverId)
      )
      return [id, answered]
    })
  )
}
