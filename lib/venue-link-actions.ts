"use server"

import { revalidatePath } from "next/cache"

import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { auditLog } from "@/lib/audit-log"
import { actorFor } from "@/lib/org-membership"

/**
 * Disputing and unlinking an event's venue.
 *
 * This is **layer 4** of the four safeguards in `lib/venue-actions.ts`, and the
 * reason the other three do not have to be bulletproof: an auto-link is
 * reversible, from both ends, with a reason, audited.
 *
 * Until now `venue_link_status: "disputed"` was written by nothing. The enum
 * existed, `resolveVenueLink` preserved it across re-saves, and no screen could
 * set it — so the reversibility the venue-claim design leans on was a promise
 * with no implementation.
 *
 * Two directions, deliberately different:
 *
 *   - **The venue owner disputes.** "This event is not at my venue." They can
 *     say so but cannot silently detach it, because an owner who unlinked
 *     freely could hide events they would rather not answer for. It becomes
 *     `disputed`, which an admin resolves.
 *   - **The organiser unlinks.** It is their event. They detach it outright,
 *     and the venue owner loses access immediately — nobody should have to wait
 *     on review to stop a stranger seeing their attendee list.
 */

const MIN_REASON = 10

export interface VenueLinkedEvent {
  id: string
  title: string
  startAt: string
  status: string
  organiserName: string | null
  linkStatus: string | null
  venueName: string
}

/**
 * Events linked to a venue this org owns.
 *
 * Reads `events.venue_id` rather than grouping by `venue_name` string, so two
 * spellings of one room cannot read as two venues here.
 */
export async function getLinkedEventsForOwner(): Promise<VenueLinkedEvent[]> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const actor = await actorFor(session.user)
  if (actor.role !== "venue_owner" && actor.role !== "app_admin") return []

  const events = await db.events.findMany({
    where: {
      deleted_at: null,
      venue_id: { not: null },
      ...(actor.role === "app_admin"
        ? {}
        : { venue: { owner_org_id: { in: actor.orgIds } } }),
    },
    orderBy: { start_time: "desc" },
    take: 200,
    select: {
      id: true,
      title: true,
      start_time: true,
      status: true,
      venue_link_status: true,
      venue: { select: { name: true } },
      organizer_org: { select: { display_name: true } },
    },
  })

  return events.map((e) => ({
    id: e.id,
    title: e.title,
    startAt: e.start_time.toISOString(),
    status: e.status,
    organiserName: e.organizer_org?.display_name ?? null,
    linkStatus: e.venue_link_status,
    venueName: e.venue?.name ?? "—",
  }))
}

/**
 * The venue owner says an event is not theirs.
 *
 * Does not detach the event — that is the organiser's or an admin's call. What
 * it does is stop the claim being silent: the link is flagged, the reason is
 * recorded, and it shows up as something to resolve.
 */
export async function disputeVenueLink(eventId: string, reason: string): Promise<void> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")
  const actor = await actorFor(session.user)

  const trimmed = reason.trim()
  if (trimmed.length < MIN_REASON) {
    throw new Error("Say why — an admin reads this to decide.")
  }

  const event = await db.events.findUnique({
    where: { id: eventId, deleted_at: null },
    select: {
      id: true,
      title: true,
      venue_id: true,
      venue_link_status: true,
      venue: { select: { owner_org_id: true, name: true } },
    },
  })
  if (!event?.venue_id) throw new Error("This event is not linked to a venue.")

  // Only the owner of the venue in question, or an admin. An organiser
  // disputing their own link would be unlinking, which is a different action
  // with different consequences.
  const ownsVenue =
    event.venue?.owner_org_id !== null &&
    event.venue?.owner_org_id !== undefined &&
    actor.orgIds.includes(event.venue.owner_org_id)
  if (actor.role !== "app_admin" && !ownsVenue) throw new Error("Forbidden")

  if (event.venue_link_status === "disputed") return

  await db.events.update({
    where: { id: eventId },
    data: { venue_link_status: "disputed" },
  })

  auditLog({
    userId: actor.id,
    action: "venue.link_disputed",
    resource: "event",
    resourceId: eventId,
    details: { venueId: event.venue_id, venue: event.venue?.name, reason: trimmed },
  })

  revalidatePath("/dashboard/venues")
  revalidatePath(`/dashboard/events/${eventId}`)
}

/**
 * The venue owner accepts the link.
 *
 * `confirmed` is what makes the auto-link settled, and it can only be set here
 * — never from a request body. `lib/venue-link.ts` explains why: a client that
 * could send it would attach its event to someone else's venue and mark it
 * agreed in one call.
 */
export async function confirmVenueLink(eventId: string): Promise<void> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")
  const actor = await actorFor(session.user)

  const event = await db.events.findUnique({
    where: { id: eventId, deleted_at: null },
    select: { id: true, venue_id: true, venue: { select: { owner_org_id: true, name: true } } },
  })
  if (!event?.venue_id) throw new Error("This event is not linked to a venue.")

  const ownsVenue =
    event.venue?.owner_org_id !== null &&
    event.venue?.owner_org_id !== undefined &&
    actor.orgIds.includes(event.venue.owner_org_id)
  if (actor.role !== "app_admin" && !ownsVenue) throw new Error("Forbidden")

  await db.events.update({
    where: { id: eventId },
    data: { venue_link_status: "confirmed" },
  })

  auditLog({
    userId: actor.id,
    action: "venue.link_confirmed",
    resource: "event",
    resourceId: eventId,
    details: { venueId: event.venue_id, venue: event.venue?.name },
  })
  revalidatePath("/dashboard/venues")
}

/**
 * Detach an event from its venue.
 *
 * The organiser's side of layer 4, and the one that takes effect immediately:
 * the venue owner loses the chatroom, the attendee count and the feedback the
 * moment this runs. Nobody should have to wait on a review to stop a stranger
 * seeing their attendee list.
 *
 * The venue *name* survives as free text, because the event really was held
 * there — clearing it would punish an organiser for correcting a bad link.
 */
export async function unlinkEventVenue(eventId: string, reason: string): Promise<void> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")
  const actor = await actorFor(session.user)

  const trimmed = reason.trim()
  if (trimmed.length < MIN_REASON) {
    throw new Error("Give a reason — it is recorded against the venue.")
  }

  const event = await db.events.findUnique({
    where: { id: eventId, deleted_at: null },
    select: {
      id: true,
      venue_id: true,
      venue_name: true,
      organizer_org_id: true,
      venue: { select: { name: true } },
    },
  })
  if (!event?.venue_id) throw new Error("This event is not linked to a venue.")

  const isOrganiser =
    event.organizer_org_id !== null && actor.orgIds.includes(event.organizer_org_id)
  if (actor.role !== "app_admin" && !isOrganiser) throw new Error("Forbidden")

  await db.events.update({
    where: { id: eventId },
    data: {
      venue_id: null,
      venue_link_status: null,
      // Keep the name. The event was held there; only the link is wrong.
      venue_name: event.venue_name ?? event.venue?.name ?? null,
    },
  })

  auditLog({
    userId: actor.id,
    action: "venue.link_removed",
    resource: "event",
    resourceId: eventId,
    details: { venueId: event.venue_id, venue: event.venue?.name, reason: trimmed },
  })

  revalidatePath("/dashboard/venues")
  revalidatePath(`/dashboard/events/${eventId}`)
}
