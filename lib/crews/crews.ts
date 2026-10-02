// Relative imports throughout — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import { randomBytes } from "crypto"
import type { Prisma, connection_intent } from "@prisma/client"
import { z } from "zod"

import { ageFrom, isAdult, mayParticipate } from "../age"
import { errorResponse } from "../api-response"
import { CREW } from "../constants"
import { conversationPair } from "../conversations"
import { db } from "../db"
import { friendIdsOf } from "../friends"
import { logger } from "../logger"
import { findProfileContactInfo } from "../moderation/contact-info"
import { foldText, hasInvisibleChars } from "../moderation/fold"
import { checkKeywords } from "../moderation/keyword-filter"
import { checkTextContent, notChecked, type ModerationCheck } from "../moderation/openai-moderation"
import { sendPushNotification } from "../push-notifications"
import { closeRoomSockets, leaveRoomSockets } from "../room-close"
import { blocksBetween } from "./blocks"
import { activeMemberWhere, lockCrew, settleLocked } from "./sweep"

export { activeMemberWhere } from "./sweep"

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
 * - **The name and bio are a card strangers see**, so they are folded
 *   (lib/moderation/fold.ts), go through the moderation pipeline and the
 *   strict contact-detail reading (`findProfileContactInfo`), and are refused
 *   on write, never stored. A card can be reported (`reportCrew`); a moderator
 *   can hide or dissolve the crew (app/dashboard/moderation/reports).
 * - **Nobody kept apart shares a crew** (C5/C6): a block or a closed
 *   conversation between an invitee and anybody in the crew means no invite
 *   and no accept, and a block or an unfriend withdraws the invites between
 *   the pair (`dropCrewInvitesBetween`, lib/crews/blocks.ts).
 * - **Caps** (C10, `CREW`): crews owned, joined and made per day; one invite
 *   push per inviter and invitee a day; invites lapse after 14 days; a no is
 *   not re-asked for 30; an owner's removal sticks.
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

/*
 * Folded before anything reads them (lib/moderation/fold.ts): the keyword
 * filter, the contact-detail reading and OpenAI all see what the screen will
 * show, and the folded form is what is stored. A name with an invisible
 * character in it is refused outright — nobody types one by accident into a
 * name, and it is how a name smuggles a number past a filter. A bio has them
 * stripped instead: pasted text carries them innocently.
 */
const crewName = z
  .string()
  .refine((s) => !hasInvisibleChars(s), { message: "A crew name can't contain invisible characters" })
  .transform((s) => foldText(s).trim().replace(/\s+/g, " "))
  .refine((s) => characters(s) >= CREW.NAME_MIN && characters(s) <= CREW.NAME_MAX, {
    message: `A crew name is ${CREW.NAME_MIN}–${CREW.NAME_MAX} characters`,
  })

const crewBio = z
  .string()
  .transform((s) => foldText(s).trim())
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
  status: 400 | 403 | 404 | 409 | 429
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
const OWNS_ENOUGH: CrewRefusal = { refusal: `You can own up to ${CREW.MAX_OWNED} crews at a time.`, status: 409 }
const IN_ENOUGH: CrewRefusal = { refusal: `You can be in up to ${CREW.MAX_JOINED} crews at a time.`, status: 409 }
const MADE_ENOUGH: CrewRefusal = { refusal: "That's enough new crews for today — try again tomorrow.", status: 429 }

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
 * onboarding (`mayParticipate`). The age must be **known** to be 18 or over: an
 * account with no age is refused too (C9), because a crew puts its members on
 * a card in front of adult strangers, and "we never asked" is not "18+". A
 * crew is new, so nothing that existed is taken away.
 */
export async function mayJoinCrews(userId: string): Promise<boolean> {
  const profile = await db.profiles.findUnique({
    where: { id: userId },
    select: { onboarded: true, age: true, date_of_birth: true, user: { select: { suspended_at: true, deletedAt: true } } },
  })
  if (!profile || profile.user.suspended_at || profile.user.deletedAt || !mayParticipate(profile)) return false
  const age = ageFrom(profile)
  return age !== null && isAdult(age)
}

/** The ids among `userIds` that are not friends of `inviterId` — must be none. */
async function strangersTo(inviterId: string, userIds: string[]): Promise<string[]> {
  const friends = new Set(await friendIdsOf(inviterId))
  return userIds.filter((id) => !friends.has(id))
}

/**
 * One person's crew-joining serialised: their own advisory lock, so two
 * creates or two accepts at once cannot both pass a cap. Taken after any crew
 * lock (never before), so it cannot form a cycle with one.
 */
async function lockPerson(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crew-person:${userId}`}, 0))`
}

/** Standing crews this person is in (owned included), and owns. */
async function crewCounts(tx: Prisma.TransactionClient, userId: string): Promise<{ joined: number; owned: number }> {
  const rows = await tx.crew_members.groupBy({
    by: ["role"],
    where: { user_id: userId, crew: { dissolved_at: null } },
    _count: { _all: true },
  })
  const of = (role: string) => rows.find((r) => r.role === role)?._count._all ?? 0
  return { joined: of("owner") + of("member"), owned: of("owner") }
}

/**
 * An invite somebody can still say yes to: not declined, not a removal
 * marker, not lapsed (`CREW.INVITE_TTL_MS`). Spread into a `crew_invites` filter.
 */
export function openInviteWhere(now: Date = new Date()) {
  return { declined_at: null, removed_at: null, created_at: { gt: new Date(now.getTime() - CREW.INVITE_TTL_MS) } }
}

const isOpen = (i: { declined_at: Date | null; removed_at: Date | null; created_at: Date }, now: Date) =>
  !i.declined_at && !i.removed_at && i.created_at.getTime() > now.getTime() - CREW.INVITE_TTL_MS

/* -------------------------------------------------------------------------- */
/* Create, invite, accept, decline                                            */
/* -------------------------------------------------------------------------- */

export type CreateCrewInput = z.infer<typeof createCrewSchema>

/**
 * A new crew: the creator as its owner (consented), its room, and an invite
 * to each friend named. Every invitee must be the creator's friend, or
 * nothing is written; one kept apart from the creator (C6) is left out
 * without a word. Within the caps (C10): crews owned, crews joined, crews
 * made today — counted under the creator's own lock.
 */
export async function createCrew(
  creatorId: string,
  input: CreateCrewInput
): Promise<{ crewId: string; chatGroupId: string; invited: number } | CrewRefusal> {
  if (!(await mayJoinCrews(creatorId))) return ADULTS
  const wanted = [...new Set(input.inviteUserIds)].filter((id) => id !== creatorId)
  if ((await strangersTo(creatorId, wanted)).length > 0) return NOT_FRIENDS
  const text = await textRefusal({ name: input.name, bio: input.bio })
  if (text) return text
  const apart = await blocksBetween([creatorId], wanted)
  const invitees = wanted.filter((id) => !apart.has(`${creatorId}|${id}`))

  const now = new Date()
  const made = await db.$transaction(async (tx) => {
    await lockPerson(tx, creatorId)
    const counts = await crewCounts(tx, creatorId)
    if (counts.owned >= CREW.MAX_OWNED) return OWNS_ENOUGH
    if (counts.joined >= CREW.MAX_JOINED) return IN_ENOUGH
    const today = await tx.crews.count({
      where: { created_by: creatorId, created_at: { gt: new Date(now.getTime() - CREW.CREATE_WINDOW_MS) } },
    })
    if (today >= CREW.MAX_CREATED_PER_WINDOW) return MADE_ENOUGH

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
  if (isRefusal(made)) return made

  await notifyCrewInvites(creatorId, made.crewId, invitees)
  return { ...made, invited: wanted.length }
}

/**
 * Invite friends into a crew you are in. Refused whole if any of them is not
 * the inviter's friend (one 404, whoever they are), or if the crew would pass
 * 12 with the invites still open. Otherwise each is invited — or skipped
 * without a word, and the answer is the same either way (`invited` is how
 * many were asked for, C8), so the inviter learns nothing about anybody:
 *
 * - already in the crew, or already invited and the invite still open;
 * - declined in the last 30 days (`CREW.REINVITE_AFTER_DECLINE_MS`): a no is
 *   not re-asked, nor re-pushed, for a month; after that it is a new ask;
 * - removed by the crew's owner (`removed_at`), unless the owner is the one
 *   asking — their invite clears the marker;
 * - kept apart (a block or a closed conversation, C5/C6) from anybody in the
 *   crew.
 *
 * A lapsed invite (`CREW.INVITE_TTL_MS`) is asked again as new.
 */
export async function inviteToCrew(
  inviterId: string,
  crewId: string,
  userIds: string[]
): Promise<{ invited: number } | CrewRefusal> {
  const wanted = [...new Set(userIds)].filter((id) => id !== inviterId)
  // Before the transaction: a read of the global pool inside it would hold the
  // crew lock while waiting for a second connection.
  if ((await strangersTo(inviterId, wanted)).length > 0) return NOT_FRIENDS
  const now = new Date()

  const result = await db.$transaction(async (tx) => {
    if (!(await lockCrew(tx, crewId))) return NO_CREW
    const members = await tx.crew_members.findMany({
      where: { crew_id: crewId },
      select: { user_id: true, role: true, user: { select: { suspended_at: true, deletedAt: true } } },
    })
    const me = members.find((m) => m.user_id === inviterId && !m.user.suspended_at && !m.user.deletedAt)
    if (!me) return NO_CREW
    const active = members.filter((m) => !m.user.suspended_at && !m.user.deletedAt).map((m) => m.user_id)

    const [invites, apart] = await Promise.all([
      tx.crew_invites.findMany({
        where: { crew_id: crewId },
        select: { invited_user_id: true, declined_at: true, removed_at: true, created_at: true },
      }),
      blocksBetween(wanted, active, tx),
    ])
    const rowOf = new Map(invites.map((i) => [i.invited_user_id, i]))
    const inCrew = new Set(members.map((m) => m.user_id))
    const declineCutoff = now.getTime() - CREW.REINVITE_AFTER_DECLINE_MS

    const ask = wanted.filter((id) => {
      if (inCrew.has(id) || active.some((m) => apart.has(`${id}|${m}`))) return false
      const row = rowOf.get(id)
      if (!row) return true
      if (row.removed_at) return me.role === "owner"
      if (row.declined_at) return row.declined_at.getTime() <= declineCutoff
      return !isOpen(row, now) // lapsed: ask again
    })
    const open = invites.filter((i) => isOpen(i, now)).length
    if (members.length + open + ask.length > CREW.MAX_MEMBERS) return FULL

    const fresh = ask.filter((id) => !rowOf.has(id))
    const renewed = ask.filter((id) => rowOf.has(id))
    if (fresh.length > 0) {
      await tx.crew_invites.createMany({
        data: fresh.map((id) => ({ crew_id: crewId, invited_user_id: id, invited_by: inviterId, created_at: now })),
        skipDuplicates: true,
      })
    }
    if (renewed.length > 0) {
      await tx.crew_invites.updateMany({
        where: { crew_id: crewId, invited_user_id: { in: renewed } },
        data: { invited_by: inviterId, created_at: now, declined_at: null, removed_at: null },
      })
    }
    return { asked: ask }
  })
  if (isRefusal(result)) return result
  await notifyCrewInvites(inviterId, crewId, result.asked)
  return { invited: wanted.length }
}

/**
 * Accept an invite: the member row (with the reveal consent), the crew room's
 * member row, and the invite gone — under the crew lock, so the cap holds.
 *
 * Asked again here, under the lock, because the invite is only as good as
 * what made it (C5): the invite open; whoever sent it still in the crew and
 * still this person's friend; nobody in the crew kept apart from them (a block
 * or a closed conversation either way). Any of those failing is the same 404
 * as no invite — the invitee learns nothing about who.
 */
export async function acceptCrewInvite(
  userId: string,
  crewId: string,
  opts: { keepMeAnonymous: boolean }
): Promise<{ chatGroupId: string } | CrewRefusal> {
  if (!(await mayJoinCrews(userId))) return ADULTS
  const now = new Date()
  return db.$transaction(async (tx) => {
    if (!(await lockCrew(tx, crewId))) return NO_CREW
    const invite = await tx.crew_invites.findUnique({
      where: { crew_id_invited_user_id: { crew_id: crewId, invited_user_id: userId } },
      select: { id: true, invited_by: true, declined_at: true, removed_at: true, created_at: true },
    })
    if (!invite || !isOpen(invite, now)) return NO_CREW

    const members = await tx.crew_members.findMany({
      where: { crew_id: crewId },
      select: { user_id: true, user: { select: { suspended_at: true, deletedAt: true } } },
    })
    const active = members.filter((m) => !m.user.suspended_at && !m.user.deletedAt).map((m) => m.user_id)
    const [user1_id, user2_id] = conversationPair(userId, invite.invited_by)
    const [friends, apart] = await Promise.all([
      tx.friendships.findUnique({ where: { user1_id_user2_id: { user1_id, user2_id } }, select: { id: true } }),
      blocksBetween([userId], active, tx),
    ])
    if (!active.includes(invite.invited_by) || !friends || apart.size > 0) return NO_CREW
    if (members.length >= CREW.MAX_MEMBERS) return FULL
    await lockPerson(tx, userId)
    if ((await crewCounts(tx, userId)).joined >= CREW.MAX_JOINED) return IN_ENOUGH

    await tx.crew_members.create({
      data: { crew_id: crewId, user_id: userId, consented_reveal_at: now, keep_me_anonymous: opts.keepMeAnonymous },
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
 * invite within `CREW.REINVITE_AFTER_DECLINE_MS` cannot re-notify them, and it
 * no longer holds a seat.
 */
export async function declineCrewInvite(userId: string, crewId: string): Promise<boolean> {
  const { count } = await db.crew_invites.updateMany({
    where: { crew_id: crewId, invited_user_id: userId, declined_at: null, removed_at: null },
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
 * - removed by the owner, they get a removal marker (`removed_at`): nobody but
 *   an owner can invite them back (C10);
 * - then the crew is settled (`settleLocked`, lib/crews/sweep.ts): below two
 *   ACTIVE members it dissolves (D-15) — its room archived, the last member
 *   released, open invites withdrawn — and an owner who left hands the crew to
 *   the active member who has been in it longest.
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
    const [by, target] = await Promise.all(
      [byId, memberId].map((id) =>
        tx.crew_members.findUnique({ where: { crew_id_user_id: { crew_id: crewId, user_id: id } }, select: { role: true } })
      )
    )
    // Somebody else's removal is the owner's alone; anybody may leave.
    if (!by || !target || (byId !== memberId && by.role !== "owner")) return NO_CREW

    await tx.crew_members.delete({ where: { crew_id_user_id: { crew_id: crewId, user_id: memberId } } })
    const room = await tx.chat_groups.findUniqueOrThrow({ where: { crew_id: crewId }, select: { id: true } })
    await tx.chat_group_members.updateMany({
      where: { chat_group_id: room.id, user_id: memberId, status: { not: "banned" } },
      data: { status: "left", ...(byId === memberId && { left_at: new Date() }) },
    })
    if (byId !== memberId) {
      const marker = { removed_at: new Date(), declined_at: null, invited_by: byId }
      await tx.crew_invites.upsert({
        where: { crew_id_invited_user_id: { crew_id: crewId, invited_user_id: memberId } },
        create: { crew_id: crewId, invited_user_id: memberId, ...marker },
        update: marker,
      })
    }
    const settled = await settleLocked(tx, crewId)
    return { dissolved: settled.dissolved, roomId: room.id }
  })
  if (isRefusal(result)) return result
  if (result.dissolved) closeRoomSockets(result.roomId)
  else leaveRoomSockets(result.roomId, memberId)
  return { dissolved: result.dissolved }
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
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

export const reportCrewSchema = z.object({
  reason: z.enum(["spam", "offensive", "contact_details", "impersonation", "other"]),
  description: z.string().trim().max(500).optional(),
})

/**
 * Report a crew's card — its name or bio (C12). Filed into `message_reports`
 * as `message_type: "crew"` so it reaches the admin queue beside every other
 * report, with the name and bio as they read now (`excerpt`): the owner can
 * edit them before anyone looks, and the evidence should not move. Who
 * reported is never told to the crew. A second report of the same crew by the
 * same person while the first waits is the same report. An unknown or
 * dissolved crew is the same 404 as any crew you have no business with.
 */
export async function reportCrew(
  reporterId: string,
  crewId: string,
  input: z.infer<typeof reportCrewSchema>
): Promise<{ reported: true } | CrewRefusal> {
  const crew = await db.crews.findFirst({ where: { id: crewId, dissolved_at: null }, select: { name: true, bio: true } })
  if (!crew) return NO_CREW
  const waiting = await db.message_reports.findFirst({
    where: { reporter_id: reporterId, message_type: "crew", message_id: crewId, status: "pending" },
    select: { id: true },
  })
  if (!waiting) {
    await db.message_reports.create({
      data: {
        reporter_id: reporterId,
        message_id: crewId,
        message_type: "crew",
        reason: input.reason,
        ...(input.description && { description: input.description }),
        excerpt: [crew.name, crew.bio].filter(Boolean).join("\n"),
      },
    })
  }
  return { reported: true }
}

/* -------------------------------------------------------------------------- */
/* Pushes                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Neither names a person: a lock screen is read by whoever holds the phone,
 * the rule every push here keeps (lib/friends.ts). The app says who.
 */

/**
 * The invite push, to each invitee who has not had one from this inviter in
 * the last `CREW.INVITE_PUSH_WINDOW_MS` for another crew (C10) — read from the
 * invites themselves, so it holds across restarts and replicas. The invite is
 * written either way and shows in the app; only the push (and its bell line)
 * is spared. Never throws: the invites have committed.
 */
async function notifyCrewInvites(inviterId: string, crewId: string, inviteeIds: readonly string[]): Promise<void> {
  if (inviteeIds.length === 0) return
  try {
    const since = new Date(Date.now() - CREW.INVITE_PUSH_WINDOW_MS)
    const recent = await db.crew_invites.findMany({
      where: { invited_by: inviterId, invited_user_id: { in: [...inviteeIds] }, crew_id: { not: crewId }, created_at: { gt: since } },
      select: { invited_user_id: true },
    })
    const pushed = new Set(recent.map((r) => r.invited_user_id))
    for (const id of inviteeIds) if (!pushed.has(id)) notifyCrewInvite(id, crewId)
  } catch (error) {
    logger.warn("Crew invite pushes failed", { error: error instanceof Error ? error.message : String(error) })
  }
}

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
