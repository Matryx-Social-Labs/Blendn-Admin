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
import { placementPhase, type PlacementPhase } from "@/lib/placement-phase"
import type { placement_status } from "@prisma/client"

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

/* -------------------------------------------------------------------------- */
/* The sponsor's own screens                                                  */
/* -------------------------------------------------------------------------- */

export interface SponsorPlacementRow {
  id: string
  eventId: string
  eventTitle: string
  startTime: Date
  endTime: Date
  status: placement_status
  phase: PlacementPhase
  /** Null until at least one send has happened. */
  sends: number | null
  /** Withheld below the disclosure floor; null means "not reportable". */
  reach: number | null
  reachSuppressed: boolean
  /** What is stopping this from running, if anything. */
  blocker: string | null
}

export interface SponsorOverview {
  brandName: string | null
  /** The hero: what is going live next, and whether it is ready. */
  next: {
    eventTitle: string
    startTime: Date
    ready: boolean
    blocker: string | null
  } | null
  liveNow: number
  awaitingYou: number
  reach30d: number | null
  reach30dSuppressed: boolean
  placements: SponsorPlacementRow[]
}

/**
 * Everything the sponsor overview renders, in one call.
 *
 * ## Why the hero is readiness and not reach
 *
 * `docs/DESIGN_SYSTEM.md` says each role leads with its forward-looking
 * question. A sponsor's question at 8pm is not "how did last month go" — it is
 * *"is my ad going to run tonight, and is anything blocking it."* Reach answers
 * a Monday question and sits in a tile.
 *
 * Both outside reviewers reached that independently, against an earlier draft
 * that led with a reach number.
 *
 * ## Scoped by organisation, never by user id
 *
 * A colleague at the sponsor org sees the same placements as whoever created
 * them. That is the whole point of `actorFor` and the reason
 * `app/dashboard/actions.ts:eventScope` was wrong for venue owners.
 */
export async function getSponsorOverview(): Promise<SponsorOverview> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const actor = await actorFor(session.user)
  if (actor.orgIds.length === 0) {
    return {
      brandName: null,
      next: null,
      liveNow: 0,
      awaitingYou: 0,
      reach30d: null,
      reach30dSuppressed: false,
      placements: [],
    }
  }

  const brand = await db.sponsors.findFirst({
    where: { org_id: { in: actor.orgIds }, deleted_at: null, merged_into: null },
    select: { id: true, name: true },
  })
  if (!brand) {
    // No brand yet. Everything else is blocked on it, so the screen shows one
    // empty state rather than four.
    return {
      brandName: null,
      next: null,
      liveNow: 0,
      awaitingYou: 0,
      reach30d: null,
      reach30dSuppressed: false,
      placements: [],
    }
  }

  const rows = await db.event_sponsors.findMany({
    where: { sponsor_id: brand.id },
    select: {
      id: true,
      status: true,
      event: {
        select: {
          id: true,
          title: true,
          start_time: true,
          end_time: true,
          chat_group: { select: { id: true } },
          sponsored_messages: {
            where: { sponsor_id: brand.id },
            select: {
              is_active: true,
              moderation_status: true,
              _count: { select: { sends: true } },
            },
          },
        },
      },
    },
    orderBy: { event: { start_time: "asc" } },
  })

  const now = new Date()

  const placements: SponsorPlacementRow[] = rows.map((r) => {
    const phase = placementPhase({ status: r.status }, r.event, now)
    const campaigns = r.event.sponsored_messages
    const sends = campaigns.reduce((n, c) => n + c._count.sends, 0)

    /*
     * The blocker, in the order the sponsor can act on it. Naming the first
     * thing that is wrong beats listing everything: they fix one, reload, and
     * see the next.
     */
    let blocker: string | null = null
    if (r.status === "proposed") blocker = "Waiting for you to accept"
    else if (r.status === "draft") blocker = "The organiser has not published this yet"
    else if (r.status === "cancelled") blocker = null
    else if (!r.event.chat_group) blocker = "The event has no chatroom yet"
    else if (campaigns.length === 0) blocker = "No creative yet"
    else if (campaigns.every((c) => c.moderation_status === "pending"))
      blocker = "Creative is in review"
    else if (campaigns.every((c) => c.moderation_status === "rejected"))
      blocker = "Creative was not approved"
    else if (campaigns.every((c) => !c.is_active)) blocker = "Not switched on"

    return {
      id: r.id,
      eventId: r.event.id,
      eventTitle: r.event.title,
      startTime: r.event.start_time,
      endTime: r.event.end_time,
      status: r.status,
      phase,
      // `null`, not `0`: an ad that has not run yet has no reach, and rendering
      // zero reads as failure. `MetricTile` already distinguishes the two.
      sends: sends > 0 ? sends : null,
      reach: null,
      reachSuppressed: false,
      blocker,
    }
  })

  const upcoming = placements.filter(
    (p) => p.status === "approved" && (p.phase === "upcoming" || p.phase === "live")
  )
  const next = upcoming[0]
    ? {
        eventTitle: upcoming[0].eventTitle,
        startTime: upcoming[0].startTime,
        ready: upcoming[0].blocker === null,
        blocker: upcoming[0].blocker,
      }
    : null

  return {
    brandName: brand.name,
    next,
    liveNow: placements.filter((p) => p.phase === "live").length,
    awaitingYou: placements.filter((p) => p.status === "proposed").length,
    // Reach is materialised at event end (see the plan); until the scheduler
    // writes sends there is nothing to report, and a fabricated 0 would be
    // worse than an em dash.
    reach30d: null,
    reach30dSuppressed: false,
    placements,
  }
}

/** Accept or decline a placement somebody proposed to this sponsor. */
export async function decidePlacement(placementId: string, accept: boolean) {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const actor = await actorFor(session.user)
  if (actor.orgIds.length === 0) throw new Error("Forbidden")

  /*
   * Scoped in the WHERE, not checked after the read.
   *
   * `findFirst` by id then compare would work, but folding the ownership into
   * the query means there is no version of this function that reads a row it is
   * not allowed to touch.
   */
  const placement = await db.event_sponsors.findFirst({
    where: {
      id: placementId,
      status: "proposed",
      sponsor: { org_id: { in: actor.orgIds }, deleted_at: null, merged_into: null },
    },
    select: { id: true, event_id: true, sponsor_id: true },
  })
  if (!placement) throw new Error("Placement not found")

  await db.event_sponsors.update({
    where: { id: placement.id },
    data: {
      status: accept ? "approved" : "cancelled",
      decided_by: session.user.id,
      decided_at: new Date(),
    },
  })

  auditLog({
    userId: session.user.id,
    action: accept ? "placement.accept" : "placement.decline",
    resource: "event_sponsors",
    resourceId: placement.id,
    details: { eventId: placement.event_id, sponsorId: placement.sponsor_id },
  })

  revalidatePath("/dashboard/placements")
}

export interface MyBrand {
  id: string
  name: string
  website: string | null
  logo_url: string | null
  claimed_at: Date | null
  placementCount: number
}

/** This organisation's brand, if it has one. */
export async function getMyBrand(): Promise<MyBrand | null> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const actor = await actorFor(session.user)
  if (actor.orgIds.length === 0) return null

  const brand = await db.sponsors.findFirst({
    where: { org_id: { in: actor.orgIds }, deleted_at: null, merged_into: null },
    select: {
      id: true,
      name: true,
      website: true,
      logo_url: true,
      claimed_at: true,
      _count: { select: { placements: true } },
    },
  })
  if (!brand) return null

  return {
    id: brand.id,
    name: brand.name,
    website: brand.website,
    logo_url: brand.logo_url,
    claimed_at: brand.claimed_at,
    placementCount: brand._count.placements,
  }
}

/**
 * Create or update this organisation's brand.
 *
 * `name_key` is recomputed on every write, because it is derived and a stale key
 * silently stops the duplicate check working — the picker would offer to create
 * a second "Red Bull" beside an existing one whose key no longer matches its
 * name.
 *
 * A rename is checked against the per-org uniqueness rule the same way a
 * creation is. Two brands in one org that normalise identically is the duplicate
 * the constraint exists to prevent, and arriving there by rename is no better
 * than arriving by creation.
 */
export async function saveMyBrand(input: unknown) {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const parsed = brandSchema.safeParse(input)
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid brand")

  const actor = await actorFor(session.user)
  const orgId = actor.orgIds[0]
  if (!orgId) throw new Error("You are not a member of an organisation")

  const { name, website, logo_url } = parsed.data
  const name_key = normaliseSponsorName(name)
  if (!name_key) throw new Error("That name has no letters or digits in it")

  const existing = await db.sponsors.findFirst({
    where: { org_id: { in: actor.orgIds }, deleted_at: null, merged_into: null },
    select: { id: true },
  })

  const clash = await db.sponsors.findFirst({
    where: {
      name_key,
      org_id: orgId,
      deleted_at: null,
      merged_into: null,
      ...(existing ? { id: { not: existing.id } } : {}),
    },
    select: { id: true },
  })
  if (clash) throw new Error("Your organisation already has a brand with that name")

  const data = {
    name,
    name_key,
    website: website || null,
    logo_url: logo_url || null,
  }

  const brand = existing
    ? await db.sponsors.update({
        where: { id: existing.id },
        data,
        select: { id: true, name: true },
      })
    : await db.sponsors.create({
        data: {
          ...data,
          org_id: orgId,
          // Created BY its owner, so it is claimed from the start — there is
          // nobody to file a claim against.
          claimed_at: new Date(),
          created_by: session.user.id,
        },
        select: { id: true, name: true },
      })

  auditLog({
    userId: session.user.id,
    action: existing ? "sponsor.update" : "sponsor.create_owned",
    resource: "sponsors",
    resourceId: brand.id,
    details: { name: brand.name, orgId },
  })

  revalidatePath("/dashboard/brand")
  revalidatePath("/dashboard/placements")
  return brand
}

export interface EventSponsorRow {
  id: string
  sponsorId: string
  name: string
  logo_url: string | null
  ownerName: string | null
  status: placement_status
  phase: PlacementPhase
}

/** Brands attached to one event, for the organiser's panel. */
export async function getEventSponsors(eventId: string): Promise<EventSponsorRow[]> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const event = await db.events.findUnique({
    where: { id: eventId, deleted_at: null },
    select: { start_time: true, end_time: true, ...eventPermissionSelect },
  })
  if (!event) throw new Error("Event not found")

  const actor = await actorFor(session.user)
  if (!eventPermissions(actor, event).canOperate) throw new Error("Forbidden")

  const rows = await db.event_sponsors.findMany({
    where: { event_id: eventId },
    select: {
      id: true,
      status: true,
      sponsor: {
        select: {
          id: true,
          name: true,
          logo_url: true,
          org: { select: { display_name: true } },
        },
      },
    },
    orderBy: { created_at: "asc" },
  })

  const now = new Date()
  return rows.map((r) => ({
    id: r.id,
    sponsorId: r.sponsor.id,
    name: r.sponsor.name,
    logo_url: r.sponsor.logo_url,
    ownerName: r.sponsor.org?.display_name ?? null,
    status: r.status,
    phase: placementPhase({ status: r.status }, event, now),
  }))
}

/**
 * Remove a placement from an event.
 *
 * Cancels rather than deletes when anything has run under it: a deleted
 * placement takes its send history with it via cascade, and a sponsor's report
 * for last week should not disappear because an organiser tidied up.
 *
 * A placement with no campaigns and no sends has no history to protect, so that
 * one is a real delete — leaving `cancelled` rows nobody ever used just clutters
 * the list and eats one of the three slots.
 */
export async function removePlacement(placementId: string) {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const placement = await db.event_sponsors.findUnique({
    where: { id: placementId },
    select: {
      id: true,
      event_id: true,
      sponsor_id: true,
      event: { select: { ...eventPermissionSelect } },
    },
  })
  if (!placement) throw new Error("Placement not found")

  const actor = await actorFor(session.user)
  if (!eventPermissions(actor, placement.event).canEdit) throw new Error("Forbidden")

  const campaigns = await db.event_sponsored_messages.count({
    where: { event_id: placement.event_id, sponsor_id: placement.sponsor_id },
  })

  if (campaigns > 0) {
    await db.event_sponsors.update({
      where: { id: placementId },
      data: { status: "cancelled", decided_by: session.user.id, decided_at: new Date() },
    })
  } else {
    await db.event_sponsors.delete({ where: { id: placementId } })
  }

  auditLog({
    userId: session.user.id,
    action: campaigns > 0 ? "placement.cancel" : "placement.delete",
    resource: "event_sponsors",
    resourceId: placementId,
    details: { eventId: placement.event_id, sponsorId: placement.sponsor_id, campaigns },
  })

  revalidatePath(`/dashboard/events/${placement.event_id}/messaging`)
}
