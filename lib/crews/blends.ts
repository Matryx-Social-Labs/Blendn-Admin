// Relative imports throughout — see lib/conversations.ts.
import { firstName, UNNAMED } from "../conversation-identity"
import { db } from "../db"
import { inRoomWhere } from "../event-kind"
import { namesInRoom, visibleInRoom } from "../identity"
import { revealAt } from "../matches"
import { idForViewer } from "../room-handle"
import { ownerAdmits, ownerRoster } from "../room-kind"
import type { CrewRefusal } from "./crews"
import { crewEvent } from "./presence"

/**
 * The crew reveal, and the Blend as its people see it (plan v2 §6, owner
 * decision (a)).
 *
 * ## One tap reveals the crew — everyone who consented, and nobody else
 *
 * Any member taps reveal, in a Blend or in the event's room, and every member
 * of that crew who is at the event and has NOT switched on "keep me anonymous"
 * is revealed there. Consent was taken when they joined
 * (`crew_members.consented_reveal_at`, NOT NULL). It is written as each
 * person's own per-event reveal (`event_match_preferences.revealed`, through
 * `revealAt`) — no new identity path: `visibleInRoom` stays the one rule, and
 * a Blend shows names exactly where the event's room would.
 *
 * Scope: where it was done. A reveal at one event names nobody at another.
 * D-10: "keep me anonymous" switched on after a reveal applies from then on —
 * the reveal already made is not taken back (a face can't be unseen).
 */

const NO_CREW: CrewRefusal = { refusal: "Crew not found", status: 404 }
const NO_EVENT: CrewRefusal = { refusal: "Event not found", status: 404 }
const NOT_IN: CrewRefusal = { refusal: "Check in to reveal your crew here.", status: 403 }

/**
 * Reveal a crew at an event: each member there who consented and is not
 * keeping themselves anonymous. `revealed` is how many were written now;
 * `keptPrivate` how many stayed anonymous by their own switch.
 */
export async function revealCrewAt(
  userId: string,
  crewId: string,
  eventId: string
): Promise<{ revealed: number; keptPrivate: number } | CrewRefusal> {
  const crew = await db.crews.findFirst({
    where: { id: crewId, dissolved_at: null, members: { some: { user_id: userId, user: { suspended_at: null } } } },
    select: { id: true },
  })
  if (!crew) return NO_CREW
  if (!(await crewEvent(eventId))) return NO_EVENT
  // The one who taps is in the room — at a venue day, live there now.
  const inRoom = await db.event_check_ins.findFirst({
    where: { event_id: eventId, user_id: userId, check_in_time: { not: null }, ...inRoomWhere(userId) },
    select: { id: true },
  })
  if (!inRoom) return NOT_IN

  const there = await db.crew_members.findMany({
    where: {
      crew_id: crewId,
      // Consent is NOT NULL, so every row has it; the check is the schema's.
      user: {
        suspended_at: null,
        deletedAt: null,
        event_check_ins: { some: { event_id: eventId, check_in_time: { not: null } } },
      },
    },
    select: { user_id: true, keep_me_anonymous: true },
  })
  const consenting = there.filter((m) => !m.keep_me_anonymous).map((m) => m.user_id)
  await revealAt(eventId, consenting)
  return { revealed: consenting.length, keptPrivate: there.length - consenting.length }
}

export interface BlendPerson {
  /** Yours is your own id; anyone else's is their handle in the Blend's room. */
  userId: string
  /** Tonight's pseudonym — the one on the crew card's menagerie. */
  pseudonym: string
  /** First name, only for somebody you may recognise here (`visibleInRoom`); else null. */
  name: string | null
  photo: string | null
}

export interface BlendSideView {
  kind: "crew" | "person"
  crewId: string | null
  name: string | null
  emblemSeed: string | null
  /** "N revealed · M keep it private" — of the people on this side who are here. */
  revealed: number
  keptPrivate: number
  people: BlendPerson[]
}

/**
 * My open Blends, each as its two sides: the people here on each, by tonight's
 * pseudonym, named only where the event's room would name them. A Blend whose
 * door does not admit me — closed, not at the occurrence, a block across the
 * sides — is not listed.
 */
export async function blendsOf(viewerId: string) {
  const now = new Date()
  const rooms = await db.chat_group_members.findMany({
    where: {
      user_id: viewerId,
      status: { in: ["active", "muted"] },
      left_at: null,
      chat_group: { kind: "blend", status: "active", blend: { closed_at: null, closes_at: { gt: now } } },
    },
    select: {
      chat_group: {
        select: {
          id: true,
          blend: {
            select: {
              id: true,
              closes_at: true,
              b_user_id: true,
              occurrence: { select: { event_id: true } },
              a_crew: { select: { id: true, name: true, emblem_seed: true } },
              b_crew: { select: { id: true, name: true, emblem_seed: true } },
            },
          },
        },
      },
    },
    orderBy: { chat_group: { created_at: "desc" } },
  })

  const views = []
  for (const { chat_group: room } of rooms) {
    const blend = room.blend
    if (!blend || !(await ownerAdmits(room.id, [viewerId]))?.has(viewerId)) continue
    views.push(await blendView(viewerId, room.id, blend))
  }
  return { blends: views }
}

async function blendView(
  viewerId: string,
  roomId: string,
  blend: {
    id: string
    closes_at: Date
    b_user_id: string | null
    occurrence: { event_id: string }
    a_crew: { id: string; name: string; emblem_seed: string }
    b_crew: { id: string; name: string; emblem_seed: string } | null
  }
) {
  const eventId = blend.occurrence.event_id
  const people = [...((await ownerRoster(roomId)) ?? [])]
  const crewIds = [blend.a_crew.id, ...(blend.b_crew ? [blend.b_crew.id] : [])]
  const [names, visible, memberships, revealedRows, profiles] = await Promise.all([
    namesInRoom({ id: roomId, kind: "blend" }, people),
    visibleInRoom(viewerId, eventId, people),
    db.crew_members.findMany({
      where: { crew_id: { in: crewIds }, user_id: { in: people } },
      select: { crew_id: true, user_id: true, keep_me_anonymous: true },
    }),
    db.event_match_preferences.findMany({
      where: { event_id: eventId, user_id: { in: people }, revealed: true },
      select: { user_id: true },
    }),
    db.user.findMany({
      where: { id: { in: people } },
      select: { id: true, name: true, profile: { select: { name: true, photos: true } } },
    }),
  ])
  const revealed = new Set(revealedRows.map((r) => r.user_id))
  const profileOf = new Map(profiles.map((p) => [p.id, p]))
  const scope = { kind: "blend" as const, groupId: roomId }

  const person = (id: string): BlendPerson => {
    const p = profileOf.get(id)
    const named = visible.has(id)
    return {
      userId: idForViewer(viewerId, scope, id),
      pseudonym: names.get(id) ?? "Attendee",
      name: named ? firstName(p?.profile?.name || p?.name || UNNAMED) : null,
      photo: named ? (p?.profile?.photos?.[0] ?? null) : null,
    }
  }
  const crewSide = (crew: { id: string; name: string; emblem_seed: string }): BlendSideView => {
    const rows = memberships.filter((m) => m.crew_id === crew.id)
    return {
      kind: "crew",
      crewId: crew.id,
      name: crew.name,
      emblemSeed: crew.emblem_seed,
      revealed: rows.filter((m) => revealed.has(m.user_id)).length,
      keptPrivate: rows.filter((m) => m.keep_me_anonymous && !revealed.has(m.user_id)).length,
      people: rows.map((m) => person(m.user_id)),
    }
  }
  const sides: BlendSideView[] = [crewSide(blend.a_crew)]
  if (blend.b_crew) sides.push(crewSide(blend.b_crew))
  else if (blend.b_user_id && people.includes(blend.b_user_id)) {
    sides.push({
      kind: "person",
      crewId: null,
      name: null,
      emblemSeed: null,
      revealed: revealed.has(blend.b_user_id) ? 1 : 0,
      keptPrivate: 0,
      people: [person(blend.b_user_id)],
    })
  }
  return { blendId: blend.id, chatGroupId: roomId, eventId, closesAt: blend.closes_at, sides }
}
