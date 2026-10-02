// Relative imports throughout — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import { randomBytes } from "crypto"
import type { Prisma, connection_intent } from "@prisma/client"
import { z } from "zod"

import { ageFrom, isAdult, mayParticipate } from "../age"
import { errorResponse } from "../api-response"
import { CREW } from "../constants"
import { db } from "../db"
import { friendIdsOf } from "../friends"
import { logger } from "../logger"
import { findProfileContactInfo } from "../moderation/contact-info"
import { checkKeywords } from "../moderation/keyword-filter"
import { checkTextContent, notChecked, type ModerationCheck } from "../moderation/openai-moderation"
import { sendPushNotification } from "../push-notifications"
import { closeRoomSockets, leaveRoomSockets } from "../room-close"

/**
 * Crews: friends who go out together (plan v2 §6).
 *
 * ## The rules this module holds, and nothing else writes
 *
 * - **Made from friends.** Everyone invited into a crew is a friend of whoever
 *   invited them, checked here on every invite. There is no other way in: no
 *   search, no link a stranger could forward.
 * - **Joining is consent.** Accepting an invite (or creating the crew) writes
 *   `consented_reveal_at` — "anyone in this crew can reveal the crew, your name
 *   and photos, to people you match with" — and the route refuses without it.
 *   `keep_me_anonymous` is each member's override (owner decision (a)).
 * - **2–12.** At most `CREW.MAX_MEMBERS`, counted under a lock on the crew row
 *   so two accepts at once cannot both take the last seat. Below
 *   `CREW.MIN_MEMBERS` the crew dissolves (D-15): its room archives and its
 *   last member is let go.
 * - **The name and bio are a card strangers see**, so they go through the
 *   moderation pipeline and the strict contact-detail reading
 *   (`findProfileContactInfo`), and are refused on write, never stored.
 *
 * The crew chat is a room of kind `crew` made with the crew; who may enter it
 * is the crew's membership (`roomOwnerDenial` in lib/room-kind.ts), never a
 * member row alone.
 */

/** Curated crew tags. Never free text (§6). Slug → label. */
export const CREW_TAGS = {
  "quiz-team": "Quiz team",
  "run-club": "Run club",
  "techno-heads": "Techno heads",
  "office-gang": "Office gang",
  "birthday-crew": "Birthday crew",
  foodies: "Foodies",
  "board-gamers": "Board gamers",
  "gig-goers": "Gig goers",
  "book-club": "Book club",
  "dance-floor": "Dance floor",
} as const

export type CrewTag = keyof typeof CREW_TAGS

const TAG_SLUGS = Object.keys(CREW_TAGS) as [CrewTag, ...CrewTag[]]

/** Characters as a person counts them — and as Postgres's `char_length` does. */
export const characters = (text: string): number => [...text].length

const crewName = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, " "))
  .refine((s) => characters(s) >= CREW.NAME_MIN && characters(s) <= CREW.NAME_MAX, {
    message: `A crew name is ${CREW.NAME_MIN}–${CREW.NAME_MAX} characters`,
  })

const crewBio = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => characters(s) <= CREW.BIO_MAX, { message: `A crew bio is at most ${CREW.BIO_MAX} characters` })

const crewFields = {
  name: crewName,
  bio: crewBio.nullable().optional(),
  intent: z.array(z.enum(["dating", "networking", "friendship", "just_here"])).max(4).optional(),
  tags: z.array(z.enum(TAG_SLUGS)).max(CREW.MAX_TAGS).optional(),
  openToSolo: z.boolean().optional(),
}

/**
 * The reveal consent, as the API takes it: `true`, or the join is refused.
 * The copy the app shows beside it is in docs/API.md (Crews).
 */
const revealConsent = z.literal(true, {
  error: "Joining a crew means agreeing that anyone in it can reveal the crew to people you match with",
})

export const createCrewSchema = z.object({
  ...crewFields,
  /** Friends to invite. Every one must be a friend of the creator. */
  inviteUserIds: z.array(z.string().min(1).max(64)).max(CREW.MAX_MEMBERS - 1).default([]),
  revealConsent,
  keepMeAnonymous: z.boolean().default(false),
})

export const updateCrewSchema = z
  .object({
    name: crewName.optional(),
    bio: crewFields.bio,
    intent: crewFields.intent,
    tags: crewFields.tags,
    openToSolo: crewFields.openToSolo,
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to change" })

export const joinCrewSchema = z.object({ revealConsent, keepMeAnonymous: z.boolean().default(false) })

export const inviteSchema = z.object({
  userIds: z.array(z.string().min(1).max(64)).min(1).max(CREW.MAX_MEMBERS - 1),
})

/** A refusal a route answers as-is: the status and the sentence. */
export interface CrewRefusal {
  refusal: string
  status: 400 | 403 | 404 | 409
}

export const isRefusal = (value: unknown): value is CrewRefusal =>
  typeof value === "object" && value !== null && "refusal" in value

/** Every "you have no business with this crew" — no crew, not a member, dissolved — is this one 404. */
export const NO_CREW: CrewRefusal = { refusal: "Crew not found", status: 404 }
const FULL: CrewRefusal = { refusal: `A crew has at most ${CREW.MAX_MEMBERS} people.`, status: 409 }
/**
 * An invitee who is not your friend. One answer whoever they are — a stranger,
 * a deleted account, an id nobody has — so inviting cannot be used to learn
 * whether somebody uses the app.
 */
const NOT_FRIENDS: CrewRefusal = { refusal: "You can only invite your friends into a crew.", status: 404 }
const ADULTS: CrewRefusal = { refusal: "Crews are for people 18 and over who have finished setting up.", status: 403 }

/* -------------------------------------------------------------------------- */
/* Name and bio                                                               */
/* -------------------------------------------------------------------------- */

/** How long the OpenAI half may hold a write. The deterministic checks have already run. */
const OPENAI_BOUND_MS = 1000

/**
 * Why this crew name or bio may not be written, or null.
 *
 * The keyword filter, then contact details in the strict reading a card gets
 * (`findProfileContactInfo`: phone numbers, handles, emails, web addresses,
 * spelled out or not), then OpenAI within a bound. Contact details say which
 * — the fix is the writer's. Anything else gets one sentence that teaches
 * nothing about the filter.
 *
 * ponytail: a timeout passes, as the room's and the board's do. The two
 * deterministic checks have run by then; a second, unbounded look (the
 * board's `hideBoardPostIfFlagged`) is the upgrade if a crew name is ever
 * caught that way.
 */
export async function crewTextRefusal(field: "name" | "bio", text: string): Promise<string | null> {
  const what = field === "name" ? "a crew's name" : "a crew's bio"
  if (checkKeywords(text)?.action === "hide") return `This can't be ${what}.`
  const contact = findProfileContactInfo(text)
  if (contact.length > 0) {
    const hints = [...new Set(contact.map((c) => c.hint))].join(" ")
    return `${hints} A crew card is shown to people you haven't met, so contact details can't go on it.`
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const check = await Promise.race([
    checkTextContent(text),
    new Promise<ModerationCheck>((resolve) => {
      timeout = setTimeout(() => resolve(notChecked("timeout")), OPENAI_BOUND_MS)
    }),
  ]).finally(() => clearTimeout(timeout))
  return check.checked && check.result?.action === "hide" ? `This can't be ${what}.` : null
}

/** The first refusal among the text fields being written, or null. */
async function textRefusal(fields: { name?: string; bio?: string | null }): Promise<CrewRefusal | null> {
  for (const field of ["name", "bio"] as const) {
    const text = fields[field]
    if (!text) continue
    const refusal = await crewTextRefusal(field, text)
    if (refusal) return { refusal, status: 400 }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Who may be in a crew                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Crews are 18+ (the owner's 2026-09-27 ruling) and for people who finished
 * onboarding (`mayParticipate`). An account with a known age under 18 is
 * refused even if onboarded before the ruling: a crew is new, so nothing that
 * existed is taken away.
 */
export async function mayJoinCrews(userId: string): Promise<boolean> {
  const profile = await db.profiles.findUnique({
    where: { id: userId },
    select: { onboarded: true, age: true, date_of_birth: true, user: { select: { suspended_at: true, deletedAt: true } } },
  })
  if (!profile || profile.user.suspended_at || profile.user.deletedAt || !mayParticipate(profile)) return false
  const age = ageFrom(profile)
  return age === null || isAdult(age)
}

/** Active members of a crew that has not dissolved. The suspended are not on any crew surface. */
export const activeMemberWhere = { user: { suspended_at: null, deletedAt: null } } as const

/**
 * Serialise every change to one crew's membership for the caller's
 * transaction: a row lock on the crew. Counting members after this cannot race
 * another accept, leave or remove. Null for no such crew, or a dissolved one.
 */
async function lockCrew(tx: Prisma.TransactionClient, crewId: string): Promise<{ id: string; name: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM crews WHERE id = ${crewId}::uuid AND dissolved_at IS NULL FOR UPDATE`
  return rows[0] ?? null
}

/** The ids among `userIds` that are not friends of `inviterId` — must be none. */
async function strangersTo(inviterId: string, userIds: string[]): Promise<string[]> {
  const friends = new Set(await friendIdsOf(inviterId))
  return userIds.filter((id) => !friends.has(id))
}

/* -------------------------------------------------------------------------- */
/* Create, invite, accept, decline                                            */
/* -------------------------------------------------------------------------- */

export type CreateCrewInput = z.infer<typeof createCrewSchema>

/**
 * A new crew: the creator as its owner (consented), its room, and an invite
 * to each friend named. Every invitee must be the creator's friend, or
 * nothing is written.
 */
export async function createCrew(
  creatorId: string,
  input: CreateCrewInput
): Promise<{ crewId: string; chatGroupId: string; invited: number } | CrewRefusal> {
  if (!(await mayJoinCrews(creatorId))) return ADULTS
  const invitees = [...new Set(input.inviteUserIds)].filter((id) => id !== creatorId)
  if ((await strangersTo(creatorId, invitees)).length > 0) return NOT_FRIENDS
  const text = await textRefusal({ name: input.name, bio: input.bio })
  if (text) return text

  const now = new Date()
  const { crewId, chatGroupId } = await db.$transaction(async (tx) => {
    const crew = await tx.crews.create({
      data: {
        name: input.name,
        bio: input.bio || null,
        intent: (input.intent ?? []) as connection_intent[],
        tags: input.tags ?? [],
        open_to_solo: input.openToSolo ?? false,
        emblem_seed: randomBytes(8).toString("hex"),
        created_by: creatorId,
        members: {
          create: { user_id: creatorId, role: "owner", consented_reveal_at: now, keep_me_anonymous: input.keepMeAnonymous },
        },
        invites: { create: invitees.map((id) => ({ invited_user_id: id, invited_by: creatorId })) },
      },
      select: { id: true },
    })
    const room = await tx.chat_groups.create({
      data: {
        kind: "crew",
        crew_id: crew.id,
        name: input.name,
        members: { create: { user_id: creatorId, role: "admin" } },
      },
      select: { id: true },
    })
    return { crewId: crew.id, chatGroupId: room.id }
  })

  for (const id of invitees) notifyCrewInvite(id, crewId)
  return { crewId, chatGroupId, invited: invitees.length }
}

/**
 * Invite friends into a crew you are in. Already a member, or already
 * invited (whatever became of it), is skipped without a word: asking again
 * after a decline would re-notify somebody who said no. Refused whole if any
 * of them is not the inviter's friend, or if the crew would pass 12 with the
 * invites still open.
 */
export async function inviteToCrew(
  inviterId: string,
  crewId: string,
  userIds: string[]
): Promise<{ invited: number } | CrewRefusal> {
  const wanted = [...new Set(userIds)].filter((id) => id !== inviterId)
  const result = await db.$transaction(async (tx) => {
    if (!(await lockCrew(tx, crewId))) return NO_CREW
    const me = await tx.crew_members.findFirst({ where: { crew_id: crewId, user_id: inviterId, ...activeMemberWhere }, select: { user_id: true } })
    if (!me) return NO_CREW
    if ((await strangersTo(inviterId, wanted)).length > 0) return NOT_FRIENDS

    const [members, invites] = await Promise.all([
      tx.crew_members.findMany({ where: { crew_id: crewId }, select: { user_id: true } }),
      tx.crew_invites.findMany({ where: { crew_id: crewId }, select: { invited_user_id: true, declined_at: true } }),
    ])
    const taken = new Set([...members.map((m) => m.user_id), ...invites.map((i) => i.invited_user_id)])
    const fresh = wanted.filter((id) => !taken.has(id))
    const open = invites.filter((i) => !i.declined_at).length
    if (members.length + open + fresh.length > CREW.MAX_MEMBERS) return FULL
    if (fresh.length > 0) {
      await tx.crew_invites.createMany({
        data: fresh.map((id) => ({ crew_id: crewId, invited_user_id: id, invited_by: inviterId })),
        skipDuplicates: true,
      })
    }
    return { invited: fresh }
  })
  if (isRefusal(result)) return result
  for (const id of result.invited) notifyCrewInvite(id, crewId)
  return { invited: result.invited.length }
}

/**
 * Accept an invite: the member row (with the reveal consent), the crew room's
 * member row, and the invite gone — under the crew lock, so the cap holds.
 */
export async function acceptCrewInvite(
  userId: string,
  crewId: string,
  opts: { keepMeAnonymous: boolean }
): Promise<{ chatGroupId: string } | CrewRefusal> {
  if (!(await mayJoinCrews(userId))) return ADULTS
  return db.$transaction(async (tx) => {
    if (!(await lockCrew(tx, crewId))) return NO_CREW
    const invite = await tx.crew_invites.findUnique({
      where: { crew_id_invited_user_id: { crew_id: crewId, invited_user_id: userId } },
      select: { id: true, declined_at: true },
    })
    if (!invite || invite.declined_at) return NO_CREW
    if ((await tx.crew_members.count({ where: { crew_id: crewId } })) >= CREW.MAX_MEMBERS) return FULL

    await tx.crew_members.create({
      data: { crew_id: crewId, user_id: userId, consented_reveal_at: new Date(), keep_me_anonymous: opts.keepMeAnonymous },
    })
    await tx.crew_invites.delete({ where: { id: invite.id } })
    const room = await tx.chat_groups.findUniqueOrThrow({ where: { crew_id: crewId }, select: { id: true } })
    // A member who left and came back: the same row, open again — unless it
    // carries a ban (a suspension writes one), which only a person lifts.
    await tx.chat_group_members.upsert({
      where: { chat_group_id_user_id: { chat_group_id: room.id, user_id: userId } },
      create: { chat_group_id: room.id, user_id: userId },
      update: {},
    })
    await tx.chat_group_members.updateMany({
      where: { chat_group_id: room.id, user_id: userId, status: { not: "banned" } },
      data: { status: "active", left_at: null },
    })
    return { chatGroupId: room.id }
  })
}

/**
 * Decline: hidden from the invitee, told to nobody. The row stays so a second
 * invite cannot re-notify them, and it no longer holds a seat.
 */
export async function declineCrewInvite(userId: string, crewId: string): Promise<boolean> {
  const { count } = await db.crew_invites.updateMany({
    where: { crew_id: crewId, invited_user_id: userId, declined_at: null },
    data: { declined_at: new Date() },
  })
  return count > 0
}

/* -------------------------------------------------------------------------- */
/* Leave, remove, dissolve                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Take `memberId` out of the crew — leaving (`byId === memberId`) or removed
 * by the crew's owner. Under the crew lock:
 *
 * - their member row goes, and their room row is `left` (kept: the room's
 *   history names its senders through it);
 * - an owner who leaves hands the crew to whoever has been in it longest;
 * - below two members the crew dissolves (D-15): `dissolved_at`, its room
 *   archived, the last member released, open invites withdrawn.
 *
 * After the commit, their sockets leave the room (all of them, if it
 * dissolved). The door already refuses them; this stops a socket that joined
 * before.
 */
export async function removeFromCrew(
  byId: string,
  crewId: string,
  memberId: string
): Promise<{ dissolved: boolean } | CrewRefusal> {
  const result = await db.$transaction(async (tx) => {
    if (!(await lockCrew(tx, crewId))) return NO_CREW
    const members = await tx.crew_members.findMany({
      where: { crew_id: crewId },
      select: { user_id: true, role: true, joined_at: true },
      orderBy: { joined_at: "asc" },
    })
    const by = members.find((m) => m.user_id === byId)
    const target = members.find((m) => m.user_id === memberId)
    // Somebody else's removal is the owner's alone; anybody may leave.
    if (!by || !target || (byId !== memberId && by.role !== "owner")) return NO_CREW

    await tx.crew_members.delete({ where: { crew_id_user_id: { crew_id: crewId, user_id: memberId } } })
    const room = await tx.chat_groups.findUniqueOrThrow({ where: { crew_id: crewId }, select: { id: true } })
    await tx.chat_group_members.updateMany({
      where: { chat_group_id: room.id, user_id: memberId, status: { not: "banned" } },
      data: { status: "left", ...(byId === memberId && { left_at: new Date() }) },
    })

    const rest = members.filter((m) => m.user_id !== memberId)
    if (rest.length < CREW.MIN_MEMBERS) {
      await dissolve(tx, crewId, room.id)
      return { dissolved: true, roomId: room.id }
    }
    if (target.role === "owner") {
      await tx.crew_members.update({
        where: { crew_id_user_id: { crew_id: crewId, user_id: rest[0].user_id } },
        data: { role: "owner" },
      })
    }
    return { dissolved: false, roomId: room.id }
  })
  if (isRefusal(result)) return result
  if (result.dissolved) closeRoomSockets(result.roomId)
  else leaveRoomSockets(result.roomId, memberId)
  return { dissolved: result.dissolved }
}

/** D-15. Inside the caller's transaction, holding the crew lock. */
async function dissolve(tx: Prisma.TransactionClient, crewId: string, roomId: string): Promise<void> {
  const now = new Date()
  await tx.crews.update({ where: { id: crewId }, data: { dissolved_at: now, updated_at: now } })
  await tx.crew_members.deleteMany({ where: { crew_id: crewId } })
  await tx.crew_invites.deleteMany({ where: { crew_id: crewId } })
  await tx.chat_groups.update({ where: { id: roomId }, data: { status: "archived" } })
  await tx.chat_group_members.updateMany({
    where: { chat_group_id: roomId, status: { in: ["active", "muted"] } },
    data: { status: "left" },
  })
}

/**
 * Account erasure's second half (app/api/mobile/account). The erasure's own
 * transaction deletes the person's member rows and every invite to or from
 * them; this then settles each crew they were in, under its lock: below two
 * members it dissolves (D-15), and a crew whose owner was the erased person
 * gets the longest-standing member as its owner. Never throws — the erasure
 * has committed, and a crew left unsettled is logged; its erased member is
 * already off every crew surface.
 */
export async function settleCrewsAfterErasure(crewIds: readonly string[]): Promise<void> {
  for (const crewId of crewIds) {
    try {
      const roomId = await db.$transaction(async (tx) => {
        if (!(await lockCrew(tx, crewId))) return null
        const rest = await tx.crew_members.findMany({
          where: { crew_id: crewId },
          select: { user_id: true, role: true },
          orderBy: { joined_at: "asc" },
        })
        const room = await tx.chat_groups.findUniqueOrThrow({ where: { crew_id: crewId }, select: { id: true } })
        if (rest.length < CREW.MIN_MEMBERS) {
          await dissolve(tx, crewId, room.id)
          return room.id
        }
        if (!rest.some((m) => m.role === "owner")) {
          await tx.crew_members.update({
            where: { crew_id_user_id: { crew_id: crewId, user_id: rest[0].user_id } },
            data: { role: "owner" },
          })
        }
        return null
      })
      if (roomId) closeRoomSockets(roomId)
    } catch (error) {
      logger.error("Settling a crew after an erasure failed", {
        crewId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Edit                                                                       */
/* -------------------------------------------------------------------------- */

/** The owner edits the crew. The name and bio go through the same checks as at creation. */
export async function updateCrew(
  ownerId: string,
  crewId: string,
  input: z.infer<typeof updateCrewSchema>
): Promise<{ ok: true } | CrewRefusal> {
  const owner = await db.crew_members.findFirst({
    where: { crew_id: crewId, user_id: ownerId, role: "owner", crew: { dissolved_at: null }, ...activeMemberWhere },
    select: { user_id: true },
  })
  if (!owner) return NO_CREW
  const text = await textRefusal({ name: input.name, bio: input.bio })
  if (text) return text
  await db.$transaction([
    db.crews.update({
      where: { id: crewId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.bio !== undefined && { bio: input.bio || null }),
        ...(input.intent !== undefined && { intent: input.intent as connection_intent[] }),
        ...(input.tags !== undefined && { tags: input.tags }),
        ...(input.openToSolo !== undefined && { open_to_solo: input.openToSolo }),
        updated_at: new Date(),
      },
    }),
    // The room is named after the crew.
    ...(input.name !== undefined ? [db.chat_groups.updateMany({ where: { crew_id: crewId }, data: { name: input.name } })] : []),
  ])
  return { ok: true }
}

/**
 * A member's own switch: "keep me anonymous even when my crew reveals". From
 * now on (D-10): a reveal already written is not undone — it can't be unseen.
 */
export async function setKeepMeAnonymous(userId: string, crewId: string, keep: boolean): Promise<boolean> {
  const { count } = await db.crew_members.updateMany({
    where: { crew_id: crewId, user_id: userId, crew: { dissolved_at: null } },
    data: { keep_me_anonymous: keep },
  })
  return count > 0
}

/* -------------------------------------------------------------------------- */
/* Pushes                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Neither names a person: a lock screen is read by whoever holds the phone,
 * the rule every push here keeps (lib/friends.ts). The app says who.
 */
function notifyCrewInvite(recipientId: string, crewId: string): void {
  sendPushNotification({
    userId: recipientId,
    title: "You're invited to a crew",
    body: "A friend wants you in their crew. Open Blend'n to see.",
    data: { type: "crew_invite", crewId },
  }).catch((err: unknown) => logger.warn("Push notification failed", { context: "crew invite", error: String(err) }))
}

/** A refusal, answered the way every mobile route answers (`lib/api-response`). */
export function refusalResponse(r: CrewRefusal) {
  return errorResponse(r.refusal, r.status)
}
