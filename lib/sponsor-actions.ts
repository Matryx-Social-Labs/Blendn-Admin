"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { actorFor } from "@/lib/org-membership"
import { eventPermissionSelect, eventPermissions } from "@/lib/rbac"
import { isSameSponsorName, normaliseSponsorName } from "@/lib/sponsor-name"
import { SPONSORSHIP } from "@/lib/constants"

/**
 * Brands, claims, placements and merges.
 *
 * The shape mirrors `lib/venue-claim-actions.ts` on purpose: a sponsor is the
 * same problem as a venue. An organiser names one free-hand, the real company
 * claims it later, an admin decides, and every placement already attached comes
 * with it.
 */

/* -------------------------------------------------------------------------- */
/* Brands                                                                     */
/* -------------------------------------------------------------------------- */

const brandSchema = z.object({
  name: z.string().trim().min(2).max(120),
  website: z.string().trim().url().max(500).optional().or(z.literal("")),
  logo_url: z.string().trim().url().max(500).optional().or(z.literal("")),
})

export interface SponsorMatch {
  id: string
  name: string
  website: string | null
  logo_url: string | null
  /** Null means nobody has claimed this brand yet. */
  ownerName: string | null
  placementCount: number
  /** True when the normalised names are identical, not merely similar. */
  exact: boolean
}

/**
 * Brands that look like what the organiser is typing.
 *
 * The picker's whole job. `contains` matches the substring the way the venue
 * picker does (`lib/venue-actions.ts`), and the normalised key catches the
 * spacing and punctuation variants a substring search misses — "RedBull" does
 * not contain "Red Bull".
 *
 * Claimed status and placement count come back with the row because the picker
 * has to show them: picking the wrong "Red Bull" attaches an event to the wrong
 * company's report, and the only way a human can tell them apart is the website
 * and who owns it.
 */
export async function findSponsors(query: string): Promise<SponsorMatch[]> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const q = query.trim()
  if (q.length < 2) return []
  const key = normaliseSponsorName(q)

  const rows = await db.sponsors.findMany({
    where: {
      deleted_at: null,
      merged_into: null,
      status: "active",
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        ...(key.length >= 2 ? [{ name_key: { startsWith: key } }] : []),
      ],
    },
    select: {
      id: true,
      name: true,
      name_key: true,
      website: true,
      logo_url: true,
      org: { select: { display_name: true } },
      _count: { select: { placements: true } },
    },
    take: 10,
    orderBy: { name: "asc" },
  })

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    website: r.website,
    logo_url: r.logo_url,
    ownerName: r.org?.display_name ?? null,
    placementCount: r._count.placements,
    exact: r.name_key === key,
  }))
}

/**
 * Create a brand nobody has claimed.
 *
 * Unclaimed by construction: `org_id` stays null until a claim is approved.
 * That is the whole Path-2 flow — an organiser names a sponsor that has no
 * account, and the company inherits the row later.
 *
 * Refuses an exact normalised duplicate rather than creating a second row,
 * because the picker offered the existing one and the organiser typed past it.
 * Near-matches are NOT refused: "AT&T" and "ATT" collapse to the same key, and
 * blocking on that would make a real second brand uncreatable.
 */
export async function createUnclaimedSponsor(input: unknown) {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const parsed = brandSchema.safeParse(input)
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid brand")

  const { name, website, logo_url } = parsed.data
  const name_key = normaliseSponsorName(name)
  if (!name_key) throw new Error("That name has no letters or digits in it")

  const clash = await db.sponsors.findFirst({
    where: { name_key, deleted_at: null, merged_into: null },
    select: { id: true, name: true },
  })
  if (clash) {
    throw new Error(`“${clash.name}” already exists — pick it from the list instead`)
  }

  const sponsor = await db.sponsors.create({
    data: {
      name,
      name_key,
      website: website || null,
      logo_url: logo_url || null,
      created_by: session.user.id,
    },
    select: { id: true, name: true },
  })

  auditLog({
    userId: session.user.id,
    action: "sponsor.create_unclaimed",
    resource: "sponsors",
    resourceId: sponsor.id,
    details: { name: sponsor.name },
  })

  return sponsor
}

/* -------------------------------------------------------------------------- */
/* Placements                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Attach a brand to an event.
 *
 * An UNCLAIMED brand goes straight to `approved` on the host's own authority.
 * Requiring acceptance from a brand with no account made this path decorative:
 * the placement could never reach `approved`, so it could never carry a
 * message, so naming a sponsor achieved nothing.
 *
 * A CLAIMED brand goes to `proposed` and waits. Somebody is there to answer,
 * and attaching their name to an event without asking is not ours to do.
 */
export async function attachSponsorToEvent(eventId: string, sponsorId: string) {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const event = await db.events.findUnique({
    where: { id: eventId, deleted_at: null },
    select: { id: true, ...eventPermissionSelect },
  })
  if (!event) throw new Error("Event not found")

  const actor = await actorFor(session.user)
  if (!eventPermissions(actor, event).canEdit) throw new Error("Forbidden")

  const sponsor = await db.sponsors.findFirst({
    where: { id: sponsorId, deleted_at: null, merged_into: null, status: "active" },
    select: { id: true, name: true, org_id: true },
  })
  if (!sponsor) throw new Error("Brand not found")

  /*
   * A room people joined to talk to strangers is not an ad break.
   *
   * Counted over approved placements only — a draft nobody published, or a
   * cancelled one, is not occupying a slot.
   */
  const live = await db.event_sponsors.count({
    where: { event_id: eventId, status: { in: ["proposed", "approved"] } },
  })
  if (live >= SPONSORSHIP.MAX_PLACEMENTS_PER_EVENT) {
    throw new Error(
      `An event may carry ${SPONSORSHIP.MAX_PLACEMENTS_PER_EVENT} sponsors at most`
    )
  }

  const status = sponsor.org_id ? "proposed" : "approved"

  const placement = await db.event_sponsors.create({
    data: {
      event_id: eventId,
      sponsor_id: sponsorId,
      status,
      created_by: session.user.id,
      // An unclaimed brand is approved by the host in the same act, so the
      // decision is recorded rather than left looking unattributed.
      ...(status === "approved"
        ? { decided_by: session.user.id, decided_at: new Date() }
        : {}),
    },
    select: { id: true, status: true },
  })

  auditLog({
    userId: session.user.id,
    action: "placement.create",
    resource: "event_sponsors",
    resourceId: placement.id,
    details: { eventId, sponsorId, sponsorName: sponsor.name, status: placement.status },
  })

  revalidatePath(`/dashboard/events/${eventId}`)
  return placement
}

/* -------------------------------------------------------------------------- */
/* Merge                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Fold one brand into another.
 *
 * Claimed brands ARE mergeable. Refusing them would block the cases that
 * actually happen — acquisition, rebrand, a mistaken approval — and leave the
 * duplicate permanent.
 *
 * Every relation to `sponsors` is repointed, not just placements. A campaign
 * left pointing at a merged-away brand fails the `sponsored_active_needs_sponsor`
 * check the moment the loser is soft-deleted, or worse, keeps sending under a
 * brand that no longer exists. The test asserts this list equals the set of
 * relations declared on the model, so a future foreign key cannot be forgotten.
 */
export async function mergeSponsors(loserId: string, winnerId: string, note: string) {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")
  if (loserId === winnerId) throw new Error("A brand cannot be merged into itself")

  const [loser, winner] = await Promise.all([
    db.sponsors.findUnique({ where: { id: loserId }, select: { id: true, name: true, org_id: true } }),
    db.sponsors.findUnique({ where: { id: winnerId }, select: { id: true, name: true, org_id: true } }),
  ])
  if (!loser || !winner) throw new Error("Brand not found")

  await db.$transaction(async (tx) => {
    // Placements first. A unique on (event_id, sponsor_id) means the loser may
    // already collide with the winner at the same event; those are dropped
    // rather than repointed, since the winner is already there.
    const winnerEvents = await tx.event_sponsors.findMany({
      where: { sponsor_id: winnerId },
      select: { event_id: true },
    })
    const taken = new Set(winnerEvents.map((e) => e.event_id))

    const loserPlacements = await tx.event_sponsors.findMany({
      where: { sponsor_id: loserId },
      select: { id: true, event_id: true },
    })
    const collide = loserPlacements.filter((p) => taken.has(p.event_id)).map((p) => p.id)
    const move = loserPlacements.filter((p) => !taken.has(p.event_id)).map((p) => p.id)

    if (collide.length) {
      await tx.event_sponsors.deleteMany({ where: { id: { in: collide } } })
    }
    if (move.length) {
      await tx.event_sponsors.updateMany({
        where: { id: { in: move } },
        data: { sponsor_id: winnerId },
      })
    }

    // Campaigns. Missing this is what leaves a live campaign pointing at a
    // brand that no longer exists.
    await tx.event_sponsored_messages.updateMany({
      where: { sponsor_id: loserId },
      data: { sponsor_id: winnerId },
    })

    // Claims. A pending claim against the loser is a claim against the winner.
    await tx.sponsor_claims.updateMany({
      where: { sponsor_id: loserId },
      data: { sponsor_id: winnerId },
    })

    await tx.sponsors.update({
      where: { id: loserId },
      data: { merged_into: winnerId, deleted_at: new Date() },
    })
  })

  auditLog({
    userId: session.user.id,
    action: "sponsor.merge",
    resource: "sponsors",
    resourceId: winnerId,
    details: {
      loserId,
      loserName: loser.name,
      loserOrgId: loser.org_id,
      winnerName: winner.name,
      winnerOrgId: winner.org_id,
      note,
    },
  })

  revalidatePath("/dashboard/sponsors")
}

/**
 * The brands that would be affected by a merge, for the confirmation screen.
 *
 * An admin deciding from two normalised strings is exactly what
 * `normaliseSponsorName` warns against, so the UI shows what actually moves.
 */
export async function mergePreview(loserId: string) {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")

  const [placements, campaigns, claims] = await Promise.all([
    db.event_sponsors.count({ where: { sponsor_id: loserId } }),
    db.event_sponsored_messages.count({ where: { sponsor_id: loserId } }),
    db.sponsor_claims.count({ where: { sponsor_id: loserId } }),
  ])
  return { placements, campaigns, claims }
}

/** Exported for the test that pins merge coverage against the schema. */
export const MERGE_REPOINTS = [
  "event_sponsors",
  "event_sponsored_messages",
  "sponsor_claims",
] as const

export { isSameSponsorName }
