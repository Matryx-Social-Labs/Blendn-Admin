// Relative imports throughout — see lib/conversations.ts.
import { firstName, UNNAMED } from "../conversation-identity"
import { db } from "../db"
import { visibleInRoom } from "../identity"
import { idForViewer } from "../room-handle"
import { blendAdmitsMany, ownerAdmits } from "../room-kind"
import { blocksBetween } from "./blocks"
import type { CrewRefusal } from "./crews"
import { hereNowAt } from "./presence"

/**
 * The Blend as its people see it, and the crew reveal inside it (plan v2 §6,
 * owner decision (a), orchestrator decisions C2–C4).
 *
 * ## A reveal is scoped to ONE Blend
 *
 * Any member of a crew in an open Blend taps reveal, and each member of THAT
 * crew who is here now (`hereNowAt` the Blend's occurrence) and in the Blend's
 * room is revealed — to that Blend's people, and nobody else: not the event's
 * room, not its deck, not a DM, not another Blend. Except anybody who has
 * switched on "keep me anonymous", read again inside the transaction that
 * writes the reveal, so a switch flipped a moment before the tap holds. The
 * matched person in a crew ↔ person Blend reveals only themselves. Consent
 * was taken when each member joined (`crew_members.consented_reveal_at`, NOT
 * NULL). Stored in `blend_reveals`, read only by `blendsOf`. D-10: "keep me
 * anonymous" switched on after a reveal applies from then on — the reveal
 * already made is not taken back (a face can't be unseen).
 *
 * ## Who a Blend shows
 *
 * Its people are the snapshot taken when it matched (its member rows, C3)
 * whom its door still admits — never somebody kept apart from the viewer (a
 * block or a closed conversation), and never somebody who turned "show
 * online" off (C4). Each by tonight's pseudonym; named (first name, one photo)
 * only when they revealed in this Blend, or the event's room would name them
 * to the viewer anyway (`visibleInRoom`). Your own side is you and a count:
 * who on it revealed and who kept anonymous is never told to your own crew.
 */

const NO_BLEND: CrewRefusal = { refusal: "Blend not found", status: 404 }

const inRoom = { status: { in: ["active" as const, "muted" as const] }, left_at: null }

/** An open Blend's room, and the Blend: open means not closed, before its clock, room active. */
async function openBlend(blendId: string) {
  return db.chat_groups.findFirst({
    where: { blend_id: blendId, kind: "blend", status: "active", blend: { closed_at: null, closes_at: { gt: new Date() } } },
    select: { id: true, blend: { select: { id: true, occurrence_id: true, a_crew_id: true, b_crew_id: true, b_user_id: true } } },
  })
}

/**
 * Reveal in a Blend (`POST /blends/:blendId/reveal`): `{ revealed: true }`
 * once the reveals are written, with no count — the tapper is in the crew.
 * The same 404 for a Blend that is not open, not there, or not the caller's.
 */
export async function revealInBlend(
  userId: string,
  blendId: string
): Promise<{ revealed: true } | CrewRefusal> {
  const room = await openBlend(blendId)
  const blend = room?.blend
  if (!room || !blend) return NO_BLEND
  const mine = await db.chat_group_members.findFirst({ where: { chat_group_id: room.id, user_id: userId, ...inRoom }, select: { id: true } })
  if (!mine || !(await ownerAdmits(room.id, [userId]))?.has(userId)) return NO_BLEND

  // The matched person reveals themselves; a crew member, their crew.
  if (blend.b_user_id === userId) {
    await db.blend_reveals.createMany({ data: [{ blend_id: blend.id, user_id: userId }], skipDuplicates: true })
    return { revealed: true }
  }
  const sides = [blend.a_crew_id, ...(blend.b_crew_id ? [blend.b_crew_id] : [])]
  const side = await db.crew_members.findFirst({ where: { user_id: userId, crew_id: { in: sides } }, select: { crew_id: true } })
  if (!side) return NO_BLEND

  // Here now, in this Blend's room, and let in by its door.
  const here = await db.crew_members.findMany({
    where: {
      crew_id: side.crew_id,
      user: { suspended_at: null, deletedAt: null, event_check_ins: { some: hereNowAt(blend.occurrence_id) } },
    },
    select: { user_id: true },
  })
  const rows = await db.chat_group_members.findMany({
    where: { chat_group_id: room.id, user_id: { in: here.map((m) => m.user_id) }, ...inRoom },
    select: { user_id: true },
  })
  const admitted = (await ownerAdmits(room.id, rows.map((r) => r.user_id))) ?? new Set<string>()
  const targets = rows.map((r) => r.user_id).filter((id) => admitted.has(id))

  return db.$transaction(async (tx) => {
    // "Keep me anonymous", as it stands at the moment of writing.
    const switches = await tx.crew_members.findMany({
      where: { crew_id: side.crew_id, user_id: { in: targets } },
      select: { user_id: true, keep_me_anonymous: true },
    })
    const consenting = switches.filter((m) => !m.keep_me_anonymous).map((m) => m.user_id)
    await tx.blend_reveals.createMany({
      data: consenting.map((id) => ({ blend_id: blend.id, user_id: id })),
      skipDuplicates: true,
    })
    // No counts: the tapper is in the crew, and "1 kept private" beside the
    // faces they can see would say which crewmate said no (step 9 review, H3).
    return { revealed: true as const }
  })
}

export interface BlendPerson {
  /** Yours is your own id; anyone else's is their handle in the Blend's room. */
  userId: string
  /** Tonight's pseudonym — the one they carry in the event's room. */
  pseudonym: string
  /** First name, only for somebody revealed in this Blend or recognised in the event's room; else null. */
  name: string | null
  photo: string | null
}

export interface BlendSideView {
  kind: "crew" | "person"
  crewId: string | null
  name: string | null
  emblemSeed: string | null
  /** Your own side: you, and how many are on it — nobody else, person by person. */
  mine: boolean
  /** How many people on this side are shown to you (yours included, on your side). */
  count: number
  /**
   * "N revealed · M keep it private" — of the people on THEIR side shown to
   * you. Null on your own side: your crewmates' faces beside one pseudonym,
   * or a "1 keeps it private", would tell your crew which of you said no
   * (step 9 review, H3).
   */
  revealed: number | null
  keptPrivate: number | null
  /** Their side: each person. Your side: you alone. */
  people: BlendPerson[]
}

const crewCard = { select: { id: true, name: true, emblem_seed: true } } as const

/**
 * My open Blends, each as its two sides. A Blend whose door does not admit me
 * — closed, left, a block across the sides with me in it — is not listed.
 *
 * A fixed number of reads however many Blends (the door for every room in
 * one, `blendAdmitsMany`), plus the event room's identity rule once per event.
 */
export async function blendsOf(viewerId: string) {
  const mine = await db.chat_group_members.findMany({
    where: {
      user_id: viewerId,
      ...inRoom,
      chat_group: { kind: "blend", status: "active", blend: { closed_at: null, closes_at: { gt: new Date() } } },
    },
    select: { chat_group_id: true },
  })
  if (mine.length === 0) return { blends: [] }

  const rooms = await db.chat_groups.findMany({
    where: { id: { in: mine.map((m) => m.chat_group_id) } },
    select: {
      id: true,
      created_at: true,
      members: { where: inRoom, select: { user_id: true } },
      blend: {
        select: {
          id: true,
          closes_at: true,
          b_user_id: true,
          occurrence: { select: { event_id: true } },
          a_crew: crewCard,
          b_crew: crewCard,
        },
      },
    },
    orderBy: { created_at: "desc" },
  })
  const everyone = [...new Set(rooms.flatMap((r) => r.members.map((m) => m.user_id)))]
  const admits = await blendAdmitsMany(rooms.map((r) => r.id), everyone)
  const open = rooms.filter((r) => r.blend && admits.get(r.id)?.has(viewerId))
  if (open.length === 0) return { blends: [] }

  const people = [...new Set(open.flatMap((r) => r.members.map((m) => m.user_id)))]
  const eventIds = [...new Set(open.map((r) => r.blend!.occurrence.event_id))]
  const crewIds = [...new Set(open.flatMap((r) => [r.blend!.a_crew.id, ...(r.blend!.b_crew ? [r.blend!.b_crew.id] : [])]))]
  const [pseudonymRows, profiles, memberships, reveals, apart, visible] = await Promise.all([
    db.chat_group_members.findMany({
      where: { chat_group: { event_id: { in: eventIds } }, user_id: { in: people } },
      select: { user_id: true, anonymous_name: true, chat_group: { select: { event_id: true } } },
    }),
    db.user.findMany({
      where: { id: { in: people } },
      select: { id: true, name: true, profile: { select: { name: true, photos: true, show_online: true } } },
    }),
    db.crew_members.findMany({
      where: { crew_id: { in: crewIds }, user_id: { in: people } },
      select: { crew_id: true, user_id: true, keep_me_anonymous: true },
    }),
    db.blend_reveals.findMany({ where: { blend_id: { in: open.map((r) => r.blend!.id) } }, select: { blend_id: true, user_id: true } }),
    blocksBetween([viewerId], people),
    Promise.all(eventIds.map(async (e) => [e, await visibleInRoom(viewerId, e, people)] as const)).then((pairs) => new Map(pairs)),
  ])
  const pseudonym = new Map(pseudonymRows.map((r) => [`${r.chat_group.event_id}|${r.user_id}`, r.anonymous_name]))
  const profileOf = new Map(profiles.map((p) => [p.id, p]))
  const revealed = new Set(reveals.map((r) => `${r.blend_id}|${r.user_id}`))

  return {
    blends: open.map((room) => {
      const blend = room.blend!
      const eventId = blend.occurrence.event_id
      const scope = { kind: "blend" as const, groupId: room.id }
      const admitted = admits.get(room.id) ?? new Set<string>()
      // The snapshot, as the door lets it in now, minus whoever you are kept
      // apart from, and anybody (but you) who turned "show online" off.
      const shown = room.members
        .map((m) => m.user_id)
        .filter(
          (id) =>
            admitted.has(id) &&
            (id === viewerId || (!apart.has(`${viewerId}|${id}`) && profileOf.get(id)?.profile?.show_online !== false))
        )
      const isRevealed = (id: string) => revealed.has(`${blend.id}|${id}`)
      const person = (id: string): BlendPerson => {
        const p = profileOf.get(id)
        const named = id === viewerId || isRevealed(id) || !!visible.get(eventId)?.has(id)
        return {
          userId: idForViewer(viewerId, scope, id),
          pseudonym: pseudonym.get(`${eventId}|${id}`) || "Attendee",
          name: named ? firstName(p?.profile?.name || p?.name || UNNAMED) : null,
          photo: named ? (p?.profile?.photos?.[0] ?? null) : null,
        }
      }
      const crewSide = (crew: { id: string; name: string; emblem_seed: string }): BlendSideView => {
        const rows = memberships.filter((m) => m.crew_id === crew.id && shown.includes(m.user_id))
        const mine = rows.some((m) => m.user_id === viewerId)
        return {
          kind: "crew",
          crewId: crew.id,
          name: crew.name,
          emblemSeed: crew.emblem_seed,
          mine,
          count: rows.length,
          revealed: mine ? null : rows.filter((m) => isRevealed(m.user_id)).length,
          keptPrivate: mine ? null : rows.filter((m) => m.keep_me_anonymous && !isRevealed(m.user_id)).length,
          people: mine ? [person(viewerId)] : rows.map((m) => person(m.user_id)),
        }
      }
      const sides: BlendSideView[] = [crewSide(blend.a_crew)]
      if (blend.b_crew) sides.push(crewSide(blend.b_crew))
      else if (blend.b_user_id && shown.includes(blend.b_user_id)) {
        const mine = blend.b_user_id === viewerId
        sides.push({
          kind: "person",
          crewId: null,
          name: null,
          emblemSeed: null,
          mine,
          count: 1,
          revealed: mine ? null : isRevealed(blend.b_user_id) ? 1 : 0,
          keptPrivate: mine ? null : 0,
          people: [person(blend.b_user_id)],
        })
      }
      return { blendId: blend.id, chatGroupId: room.id, eventId, closesAt: blend.closes_at, sides }
    }),
  }
}
