// Relative imports throughout — see lib/conversations.ts.
import { CREW } from "../constants"
import { db } from "../db"
import { befriendIn, firstName, INVITE_TOKEN, lockPair, newInviteToken, personCard, personSelect } from "../friends"
import { logger } from "../logger"
import { notifyFriendshipChanged } from "../room-friends"
import { getAccessibleMediaUrl } from "../tigris"
import { blocksBetween } from "./blocks"
import { ADULTS, admitLocked, isRefusal, mayJoinCrews, tagView, type CrewRefusal } from "./crews"
import { lockCrew } from "./sweep"

/**
 * Crew invite links (crews 3-B, S7): `https://www.blendn.app/c/<token>`, for a
 * friend who is not on Blend'n — or not your Blend'n friend — yet. Rules
 * decided per advisor, 2026-11-21:
 *
 * - Any member makes one; up to `CREW.LINKS_PER_WINDOW` a day, every crew.
 * - Single use, `CREW.LINK_TTL_MS`. Good only while its sharer is an active
 *   member of a standing, unhidden crew: a sharer who leaves takes their links
 *   with them, with nothing written.
 * - An open link holds no seat. The 25 are counted at the join, under the crew
 *   lock; a full crew is a 409 and the link is not spent.
 * - Joining by it makes the joiner and the sharer friends in the same
 *   transaction (`befriendIn`, under the pair's lock).
 * - Every way a link can fail for the holder — malformed, unknown, used,
 *   revoked, lapsed, its sharer gone, the crew ended or hidden, the holder kept
 *   apart from anybody in it — is the one 404 (`NO_LINK`), and spends nothing.
 * - The sharer or the crew's owner may revoke it.
 * - Somebody the owner removed comes back only by the OWNER's link (the
 *   invite's rule, C10): anybody else's is the 404, and the marker stays.
 */

/** The friend link's one 404, word for word: `errorCode` NOT_FOUND, `reasonCode` INVITE_UNAVAILABLE. */
export const NO_LINK: CrewRefusal = { refusal: "This invite link doesn’t work any more", status: 404, reasonCode: "INVITE_UNAVAILABLE" }
/** Not a member, or no such crew: the crew routes' one 404. */
const NO_LINK_CREW: CrewRefusal = { refusal: "Crew not found", status: 404 }
const LINKS_ENOUGH: CrewRefusal = { refusal: "That’s enough invite links for today. Try again tomorrow.", status: 429 }

/** Where crew links point. `/c/`, not `/f/`: an installed build reads every `/f/` link as a friend's. */
export const CREW_LINK_BASE = "https://www.blendn.app/c/"

/** A refusal raised inside the join's transaction so its writes roll back (the friendship came out false). */
class LinkRefused extends Error {}

const linkSelect = {
  id: true,
  crew_id: true,
  created_by: true,
  created_at: true,
  crew: { select: { name: true, emblem_seed: true, bio: true, tags: true } },
  sharer: { select: personSelect },
} as const

/** The crew's active members: a link is only as good as the member who shared it. */
async function activeMembers(crewId: string, client: Pick<typeof db, "crew_members"> = db): Promise<string[]> {
  const rows = await client.crew_members.findMany({
    where: { crew_id: crewId, user: { suspended_at: null, deletedAt: null } },
    select: { user_id: true },
  })
  return rows.map((r) => r.user_id)
}

/** A link somebody may still use now, with its crew's active members; null for every way it cannot. */
async function openLink(token: string, now: Date = new Date()) {
  if (!INVITE_TOKEN.test(token)) return null
  const link = await db.crew_invite_tokens.findFirst({
    where: {
      token,
      used_at: null,
      revoked_at: null,
      created_at: { gt: new Date(now.getTime() - CREW.LINK_TTL_MS) },
      crew: { dissolved_at: null, hidden_at: null },
    },
    select: linkSelect,
  })
  if (!link) return null
  const members = await activeMembers(link.crew_id)
  return members.includes(link.created_by) ? { link, members } : null
}

/**
 * A removal marker the sharer may not lift: the owner removed them, and the
 * link is not the owner's. Read with the transaction under its crew lock.
 */
async function removedFor(
  client: Pick<typeof db, "crew_invites" | "crew_members">,
  crewId: string,
  sharerId: string,
  userId: string
): Promise<{ markerId: string; liftable: boolean } | null> {
  const marker = await client.crew_invites.findFirst({
    where: { crew_id: crewId, invited_user_id: userId, removed_at: { not: null } },
    select: { id: true },
  })
  if (!marker) return null
  const owner = await client.crew_members.count({ where: { crew_id: crewId, user_id: sharerId, role: "owner" } })
  return { markerId: marker.id, liftable: owner > 0 }
}

const expiresAt = (createdAt: Date) => new Date(createdAt.getTime() + CREW.LINK_TTL_MS).toISOString()

/** A new link into a crew you are an active member of. */
export async function createCrewLink(userId: string, crewId: string): Promise<{ token: string; url: string; expiresAt: string } | CrewRefusal> {
  const now = new Date()
  const made = await db.$transaction(async (tx) => {
    const crew = await lockCrew(tx, crewId)
    if (!crew || crew.hidden || !(await activeMembers(crewId, tx)).includes(userId)) return NO_LINK_CREW
    // The day's count under the sharer's own lock, so two taps at once cannot both pass it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crew-links:${userId}`}, 0))`
    const today = await tx.crew_invite_tokens.count({
      where: { created_by: userId, created_at: { gt: new Date(now.getTime() - CREW.CREATE_WINDOW_MS) } },
    })
    if (today >= CREW.LINKS_PER_WINDOW) return LINKS_ENOUGH
    return tx.crew_invite_tokens.create({
      data: { crew_id: crewId, token: newInviteToken(), created_by: userId, created_at: now },
      select: { token: true, created_at: true },
    })
  })
  if (isRefusal(made)) return made
  return { token: made.token, url: `${CREW_LINK_BASE}${made.token}`, expiresAt: expiresAt(made.created_at) }
}

/** Revoke an unused link: its sharer, or the crew's owner. False when there is none such. */
export async function revokeCrewLink(userId: string, crewId: string, token: string): Promise<boolean> {
  if (!INVITE_TOKEN.test(token)) return false
  const { count } = await db.crew_invite_tokens.updateMany({
    where: {
      token,
      crew_id: crewId,
      used_at: null,
      revoked_at: null,
      OR: [{ created_by: userId }, { crew: { members: { some: { user_id: userId, role: "owner" } } } }],
    },
    data: { revoked_at: new Date() },
  })
  return count > 0
}

export interface CrewLinkPreview {
  name: string
  emblemSeed: string
  /** "Crew of N": its active members. */
  size: number
  /** The sharer, who handed the link out: a first name and one photo. */
  invitedBy: { name: string; photoUrl: string | null }
}

function previewOf(found: NonNullable<Awaited<ReturnType<typeof openLink>>>): CrewLinkPreview {
  const card = personCard(found.link.sharer)
  return {
    name: found.link.crew.name,
    emblemSeed: found.link.crew.emblem_seed,
    size: found.members.length,
    invitedBy: { name: firstName(card.name), photoUrl: card.photo ? getAccessibleMediaUrl(card.photo) : null },
  }
}

/**
 * For somebody not signed in yet (the link may have been forwarded): the
 * crew's name, emblem and size and who shared it. No members, bio or tags. A
 * signed-in caller gets the block rule too, so the public door shows nothing
 * the signed-in one hides.
 */
export async function crewLinkPreview(token: string, viewerId: string | null): Promise<CrewLinkPreview | null> {
  const found = await openLink(token)
  if (!found) return null
  if (viewerId && (await blocksBetween([viewerId], found.members)).size > 0) return null
  return previewOf(found)
}

/** The invite card for a signed-in holder: the preview, its line and tags, when it lapses, and whether you are in. */
export async function crewLinkFor(viewerId: string, token: string) {
  const found = await openLink(token)
  if (!found || (await blocksBetween([viewerId], found.members)).size > 0) return null
  const removed = await removedFor(db, found.link.crew_id, found.link.created_by, viewerId)
  if (removed && !removed.liftable) return null
  return {
    crewId: found.link.crew_id,
    ...previewOf(found),
    bio: found.link.crew.bio,
    tags: tagView(found.link.crew.tags),
    expiresAt: expiresAt(found.link.created_at),
    member: found.members.includes(viewerId),
  }
}

/**
 * Join by a link: the member row (with the reveal consent), the crew room, the
 * friendship with the sharer and the link spent — one transaction, under the
 * crew lock, the pair's lock and the joiner's own. Asked again under the lock:
 * a link spent or revoked meanwhile, a sharer who left, a block landing.
 * Somebody already in gets their room back and spends nothing.
 */
export async function joinByLink(
  userId: string,
  token: string,
  opts: { keepMeAnonymous: boolean }
): Promise<{ crewId: string; chatGroupId: string } | CrewRefusal> {
  if (!(await mayJoinCrews(userId))) return ADULTS
  const first = await openLink(token)
  if (!first) return NO_LINK
  const crewId = first.link.crew_id
  const sharerId = first.link.created_by
  const now = new Date()

  try {
    const joined = await db.$transaction(async (tx) => {
      const crew = await lockCrew(tx, crewId)
      if (!crew || crew.hidden) return NO_LINK
      // Spendable still, read under the crew lock that every join of this crew takes.
      const link = await tx.crew_invite_tokens.findFirst({
        where: { id: first.link.id, used_at: null, revoked_at: null, created_at: { gt: new Date(now.getTime() - CREW.LINK_TTL_MS) } },
        select: { id: true },
      })
      const members = await tx.crew_members.findMany({
        where: { crew_id: crewId },
        select: { user_id: true, user: { select: { suspended_at: true, deletedAt: true } } },
      })
      const active = members.filter((m) => !m.user.suspended_at && !m.user.deletedAt).map((m) => m.user_id)
      if (!link || !active.includes(sharerId)) return NO_LINK
      if (members.some((m) => m.user_id === userId)) {
        const room = await tx.chat_groups.findUniqueOrThrow({ where: { crew_id: crewId }, select: { id: true } })
        return { chatGroupId: room.id, befriended: false }
      }
      if ((await blocksBetween([userId], active, tx)).size > 0) return NO_LINK
      const removed = await removedFor(tx, crewId, sharerId, userId)
      if (removed && !removed.liftable) return NO_LINK
      // The owner's own link is the owner asking them back, as the owner's invite clears the marker.
      if (removed) await tx.crew_invites.delete({ where: { id: removed.markerId } })

      await lockPair(tx, userId, sharerId)
      const admitted = await admitLocked(tx, crewId, userId, members.length, opts, now)
      if (isRefusal(admitted)) return admitted
      // Not connectable (blocked, a closed match) or still pseudonymous to each other: nothing is written.
      if (!(await befriendIn(tx, userId, sharerId))) throw new LinkRefused()
      await tx.crew_invite_tokens.update({ where: { id: link.id }, data: { used_at: now, used_by: userId } })
      return { chatGroupId: admitted.chatGroupId, befriended: true }
    })
    if (isRefusal(joined)) return joined
    if (joined.befriended) void notifyFriendshipChanged(userId, sharerId)
    return { crewId, chatGroupId: joined.chatGroupId }
  } catch (error) {
    if (error instanceof LinkRefused) return NO_LINK
    logger.error("Crew link join failed", { error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
