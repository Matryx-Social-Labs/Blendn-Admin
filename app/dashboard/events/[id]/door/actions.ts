"use server"

import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { currentEntryCode, entryPauseInForce } from "@/lib/entry-code"
import { clearEntryPause, recentWrongCodes, setEntryPause } from "@/lib/entry-code-gate"
import { resolveOccurrence, type OccurrenceSlot } from "@/lib/occurrences"
import { actorFor } from "@/lib/org-membership"
import { eventPermissionSelect, eventPermissions } from "@/lib/rbac"
import { roomHandle } from "@/lib/room-handle"
import { admitAtDoor, doorCount, type DoorAnswer } from "@/lib/ticket-door"

/** What the door's phone is told: `DoorAnswer` with its times as ISO strings, and the new count after a let-in. */
export type DoorReply =
  | { kind: "let_in"; code: string; typeName: string; nth: number; of: number; at: string; count: { inside: number; of: number } }
  | { kind: "used"; code: string; typeName: string; at: string }
  | { kind: "invalid"; code: string | null }
  | { kind: "wait"; retryAfter: number }
  | { kind: "not_authorized" }
  | { kind: "off" }

/**
 * The door's one action (SCRUM-1014): `admitAtDoor` authorizes (canOperate),
 * limits (per operator, per event) and redeems in one write. A typed code or
 * a scanned QR; never a name back.
 */
export async function admitTicket(eventId: string, credential: { code: string } | { qr: string }): Promise<DoorReply> {
  const session = await getAuth()
  if (!session?.user) return { kind: "not_authorized" }
  const cred = "qr" in credential ? { qr: String(credential.qr).slice(0, 200) } : { code: String(credential.code).slice(0, 12) }
  const a: DoorAnswer = await admitAtDoor(eventId, { id: session.user.id, role: session.user.role }, cred)
  if (a.kind === "let_in") return { ...a, at: a.at.toISOString(), count: await doorCount(eventId) }
  if (a.kind === "used") return { ...a, at: a.at.toISOString() }
  return a
}

/** One arrival by the door code, as the host sees it: the room pseudonym, the time, and the room's handle for Remove. Never an identity. */
export interface DoorArrival {
  pseudonym: string
  at: string
  ref: string
}

/** The host's Door (gate 13; design/02a SPEC §5). */
export type DoorView =
  | { kind: "not_authorized" }
  | { kind: "closed" }
  | {
      kind: "open"
      /** Null unless asked for and live: the Door tab never asks, only the full-screen view. */
      code: { value: string; rotatesAt: string } | null
      /** In force now; `wrong` is the event's wrong codes in the last 10 minutes, null when the store cannot say. */
      paused: { wrong: number | null } | null
      byCode: number
      byGps: number
      /** Newest first. */
      arrivals: DoorArrival[]
    }

const ARRIVALS_SHOWN = 10

/** The event and occurrence the caller may operate, now. Re-checked on every call (each 30 s re-ask). */
async function operatedDoor(eventId: string) {
  const session = await getAuth()
  if (!session?.user || typeof eventId !== "string") return null
  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null },
    select: { ...eventPermissionSelect, id: true, status: true, door_code_paused_at: true, chat_group: { select: { id: true } } },
  })
  if (!event || !eventPermissions(await actorFor(session.user), event).canOperate) return null
  const now = new Date()
  const slot = event.status === "published" && event.kind !== "venue_day" ? await resolveOccurrence(event.id, now) : null
  return { userId: session.user.id, event, now, occurrence: slot?.ok ? slot.occurrence : null }
}

async function viewOf(door: NonNullable<Awaited<ReturnType<typeof operatedDoor>>>, withCode: boolean): Promise<DoorView> {
  const { event, now } = door
  if (!door.occurrence) return { kind: "closed" }
  const occurrence: OccurrenceSlot = door.occurrence
  const paused = entryPauseInForce(event.door_code_paused_at, occurrence, now)
  const guests = { occurrence_id: occurrence.id, kind: "attendee" as const }
  const [byMethod, latest, wrong] = await Promise.all([
    db.event_check_ins.groupBy({ by: ["method"], where: guests, _count: { _all: true } }),
    db.event_check_ins.findMany({
      where: { ...guests, method: "door_code" },
      orderBy: { check_in_time: "desc" },
      take: ARRIVALS_SHOWN,
      select: { user_id: true, check_in_time: true },
    }),
    paused ? recentWrongCodes(occurrence.id) : Promise.resolve(null),
  ])
  const names = event.chat_group
    ? await db.chat_group_members.findMany({
        where: { chat_group_id: event.chat_group.id, user_id: { in: latest.map((r) => r.user_id) } },
        select: { user_id: true, anonymous_name: true },
      })
    : []
  const nameOf = new Map(names.map((n) => [n.user_id, n.anonymous_name]))
  const count = (method: "gps" | "door_code") => byMethod.find((m) => m.method === method)?._count._all ?? 0
  const live = withCode && !paused ? currentEntryCode(event.id, occurrence.id, now) : null
  return {
    kind: "open",
    code: live && { value: live.code, rotatesAt: live.rotatesAt },
    paused: paused ? { wrong } : null,
    byCode: count("door_code"),
    byGps: count("gps"),
    arrivals: latest.map((r) => ({
      pseudonym: nameOf.get(r.user_id) ?? "A guest",
      at: (r.check_in_time ?? now).toISOString(),
      ref: roomHandle(event.id, r.user_id),
    })),
  }
}

/** The Door tab (`withCode` false) and the full-screen door view (`withCode` true), re-asked at each turn of the code and each ops push. */
export async function readDoor(eventId: string, withCode: boolean): Promise<DoorView> {
  const door = await operatedDoor(eventId)
  return door ? viewOf(door, withCode === true) : { kind: "not_authorized" }
}

/** Pause the code by hand; audited as the host. */
export async function pauseEntryCode(eventId: string): Promise<DoorView> {
  const door = await operatedDoor(eventId)
  if (!door) return { kind: "not_authorized" }
  if (!door.occurrence) return { kind: "closed" }
  await setEntryPause(door.event.id, door.occurrence, door.userId, door.now)
  return viewOf({ ...door, event: { ...door.event, door_code_paused_at: door.now } }, false)
}

/** Resume the code: the pause lifts and the event's counters start again; audited as the host. */
export async function resumeEntryCode(eventId: string): Promise<DoorView> {
  const door = await operatedDoor(eventId)
  if (!door) return { kind: "not_authorized" }
  if (!door.occurrence) return { kind: "closed" }
  await clearEntryPause(door.event.id, door.occurrence.id, door.userId)
  return viewOf({ ...door, event: { ...door.event, door_code_paused_at: null } }, false)
}
