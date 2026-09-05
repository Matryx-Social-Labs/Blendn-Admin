"use server"

import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { auditLog } from "@/lib/audit-log"
import { haversineDistanceMeters, getBoundingBox } from "@/lib/geo"
import { validateGeofence, type Geofence } from "@/lib/geofence"
import { defaultExtentMetres, venueTypeLabel } from "@/lib/venue-types"
import type { venue_type } from "@prisma/client"

/**
 * Creating and claiming venues — the first write path this table has ever had.
 *
 * `venues` shipped in v0.18.0 with a detail page, a search index and a
 * permission resolver reading it, and **nothing has ever inserted a row**. So
 * `/dashboard/venues/[id]` 404s for every id, and the venue-owner dashboard
 * reconstructs "venues" by string-grouping `events.venue_name`.
 *
 * ## Why this is not a CRUD form
 *
 * A venue carries **operational control over other people's events**. An
 * organiser picking a claimed venue auto-links immediately, and the owner then
 * gets the chatroom, moderation and attendee list for an event that is not
 * theirs. So a false claim is an access-control failure, not a data-quality one.
 *
 * Four layers, in the order they fire:
 *
 *   1. **proximity dedup** — you cannot silently create a second record for a
 *      building that already exists
 *   2. **admin review** — a claim needs a human, because physical ownership
 *      cannot be verified from a form
 *   3. **one owner per venue** — a second claim is a dispute
 *   4. **auto-link is reversible** — the owner can unlink anything they did not
 *      agree to
 *
 * Layer 4 is why 1–3 do not have to be bulletproof: the damage is bounded and
 * undoable.
 */

/** Two records for one building is how "The Loft" and "the loft" both exist. */
const DUPLICATE_RADIUS_M = 100

async function requireUser() {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")
  return session.user
}

export interface NearbyVenue {
  id: string
  name: string
  address: string | null
  city: string | null
  distanceMetres: number
  claimed: boolean
  /** Only shown to admins — otherwise it enumerates who owns what. */
  ownerName: string | null
}

/**
 * What already exists near this pin.
 *
 * Called before a create, so the answer to "add The Loft" can be "The Loft is
 * already here — claim it" rather than a second row nobody reconciles.
 */
export async function venuesNear(lat: number, lng: number): Promise<NearbyVenue[]> {
  const user = await requireUser()
  const isAdmin = user.role === "app_admin"

  // Bounding box first so the database does the coarse filter on an index,
  // then exact haversine in memory. The box is generous; the filter below is
  // the real one.
  const box = getBoundingBox(lat, lng, DUPLICATE_RADIUS_M / 1000)
  const candidates = await db.venues.findMany({
    where: {
      deleted_at: null,
      latitude: { gte: box.minLat, lte: box.maxLat },
      longitude: { gte: box.minLon, lte: box.maxLon },
    },
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      latitude: true,
      longitude: true,
      owner_org_id: true,
      owner_org: { select: { display_name: true } },
    },
    take: 50,
  })

  return candidates
    .flatMap((v) => {
      if (v.latitude === null || v.longitude === null) return []
      const distanceMetres = Math.round(
        haversineDistanceMeters(lat, lng, v.latitude, v.longitude)
      )
      if (distanceMetres > DUPLICATE_RADIUS_M) return []
      return [
        {
          id: v.id,
          name: v.name,
          address: v.address,
          city: v.city,
          distanceMetres,
          claimed: v.owner_org_id !== null,
          // A host learning which company owns which venue is a customer list.
          ownerName: isAdmin ? (v.owner_org?.display_name ?? null) : null,
        },
      ]
    })
    .sort((a, b) => a.distanceMetres - b.distanceMetres)
}

export interface CreateVenueInput {
  name: string
  venueType: venue_type | null
  address?: string | null
  city?: string | null
  lat: number
  lng: number
  capacity?: number | null
  geofence?: unknown
  /** Set after the caller has seen `venuesNear` and chosen to add anyway. */
  acknowledgedDuplicates?: boolean
}

/**
 * Create a venue.
 *
 * An admin creates unclaimed records. A venue owner creates a venue **already
 * owned by their organisation** — they are describing their own place, and
 * making them create-then-claim it would be ceremony with no safety value.
 *
 * An organiser cannot create venues: a venue grants operational control over
 * other people's events, and an organiser has no claim to that.
 */
export async function createVenue(input: CreateVenueInput): Promise<{ id: string }> {
  const user = await requireUser()
  if (user.role !== "app_admin" && user.role !== "venue_owner") {
    throw new Error("Forbidden")
  }

  const name = input.name.trim()
  if (name.length < 2) throw new Error("Give the venue a name.")
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) {
    throw new Error("Place the venue on the map first.")
  }

  // Layer 1. Refused rather than warned, because the caller has already been
  // shown the neighbours by `venuesNear` and has to say it meant it.
  if (!input.acknowledgedDuplicates) {
    const nearby = await venuesNear(input.lat, input.lng)
    if (nearby.length > 0) {
      throw new Error(
        `${nearby[0].name} is already listed ${nearby[0].distanceMetres} m away. Claim it instead, or confirm this is a different place.`
      )
    }
  }

  // A venue's geofence is inherited by every event held there, so it is worth
  // getting right once. Absent, a circle sized for the venue type beats one
  // default for a café and a stadium alike.
  let geofence: Geofence | null = null
  if (input.geofence) {
    const parsed = validateGeofence(input.geofence)
    if (!parsed.ok) throw new Error(`Check-in area is not valid (${parsed.error}).`)
    geofence = parsed.fence
  } else {
    geofence = {
      type: "circle",
      lat: input.lat,
      lng: input.lng,
      radius: defaultExtentMetres(input.venueType),
      buffer: 20,
    }
  }

  const orgId =
    user.role === "venue_owner"
      ? (
          await db.organisation_members.findFirst({
            where: { user_id: user.id },
            select: { org_id: true },
          })
        )?.org_id ?? null
      : null

  if (user.role === "venue_owner" && !orgId) {
    throw new Error("Your account is not attached to an organisation yet.")
  }

  const venue = await db.venues.create({
    data: {
      name,
      venue_type: input.venueType,
      address: input.address?.trim() || null,
      city: input.city?.trim() || null,
      latitude: input.lat,
      longitude: input.lng,
      capacity: input.capacity && input.capacity > 0 ? Math.round(input.capacity) : null,
      geofence: geofence as object,
      owner_org_id: orgId,
      claimed_at: orgId ? new Date() : null,
      created_by: user.id,
    },
    select: { id: true },
  })

  auditLog({
    userId: user.id,
    action: "venue.created",
    resource: "venue",
    resourceId: venue.id,
    details: { name, venueType: input.venueType, claimed: !!orgId },
  })

  revalidatePath("/dashboard/venues")
  revalidatePath("/dashboard/venue-owners")
  return { id: venue.id }
}

export interface UpdateVenueInput {
  name?: string
  venueType?: venue_type | null
  address?: string | null
  city?: string | null
  capacity?: number | null
  geofence?: unknown
  /**
   * The pin. Both or neither — a latitude without a longitude is not a place.
   *
   * These were write-once at creation, so **a venue's coordinates could never
   * be corrected**. That matters more for a venue than for an event: an event's
   * wrong pin is wrong for one night, and a venue's is wrong for every event
   * ever held there, permanently, because nothing ages it out. It is also the
   * thing a curated place gets wrong most often, since whoever added it has
   * never stood there.
   */
  lat?: number
  lng?: number
}

/**
 * Load a live venue the caller is allowed to change, or throw.
 *
 * Not exported: a `"use server"` file may export nothing but async server
 * actions, and this is neither. Extracted because two writers now ask the same
 * question, and "may this actor change this venue" having two implementations
 * is how the two come to disagree — which is the defect this whole audit is
 * about.
 *
 * Organisation-shaped, per CLAUDE.md: membership of the owning org, never
 * `owner_id`, which has no writer at all.
 */
async function venueForWrite(
  id: string,
  user: { id: string; role: string }
): Promise<{ id: string; name: string; owner_org_id: string | null }> {
  const venue = await db.venues.findUnique({
    where: { id, deleted_at: null },
    select: { id: true, name: true, owner_org_id: true },
  })
  if (!venue) throw new Error("Venue not found")

  if (user.role !== "app_admin") {
    const member = venue.owner_org_id
      ? await db.organisation_members.findFirst({
          where: { user_id: user.id, org_id: venue.owner_org_id },
          select: { id: true },
        })
      : null
    if (!member) throw new Error("Forbidden")
  }
  return venue
}

/** Edit a venue. Owners edit their own; admins edit any. */
export async function updateVenue(id: string, input: UpdateVenueInput): Promise<void> {
  const user = await requireUser()
  await venueForWrite(id, user)

  /*
   * Both or neither, checked before anything is written. Half a coordinate pair
   * would move the venue to the equator or the prime meridian rather than
   * failing, which is a wrong answer that looks like a working save.
   */
  const movingPin = input.lat !== undefined || input.lng !== undefined
  if (movingPin && (input.lat === undefined || input.lng === undefined)) {
    throw new Error("Give both a latitude and a longitude, or neither.")
  }
  if (movingPin) {
    const { lat, lng } = input as { lat: number; lng: number }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new Error("Latitude must be between -90 and 90.")
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new Error("Longitude must be between -180 and 180.")
    }
  }

  let geofence: Geofence | undefined
  if (input.geofence !== undefined) {
    const parsed = validateGeofence(input.geofence)
    if (!parsed.ok) throw new Error(`Check-in area is not valid (${parsed.error}).`)
    geofence = parsed.fence
  }

  await db.venues.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.venueType !== undefined ? { venue_type: input.venueType } : {}),
      ...(input.address !== undefined ? { address: input.address?.trim() || null } : {}),
      ...(input.city !== undefined ? { city: input.city?.trim() || null } : {}),
      ...(input.capacity !== undefined
        ? { capacity: input.capacity && input.capacity > 0 ? Math.round(input.capacity) : null }
        : {}),
      ...(geofence ? { geofence: geofence as object } : {}),
      ...(movingPin ? { latitude: input.lat, longitude: input.lng } : {}),
    },
  })

  auditLog({
    userId: user.id,
    action: "venue.updated",
    resource: "venue",
    resourceId: id,
    details: { fields: Object.keys(input) },
  })
  revalidatePath("/dashboard/venues")
  revalidatePath(`/dashboard/venues/${id}`)
}

/**
 * Retire a venue. Owners retire their own; admins retire any.
 *
 * ## The column that had no writer
 *
 * `venues.status` and `venues.deleted_at` have existed since the table did.
 * Every read filters `deleted_at: null`, `venue_status.archived` was declared,
 * and `@@index([status])` indexed a column that never changed — because
 * **nothing ever wrote either one**. There was no `deleteVenue`, no
 * `archiveVenue`, no retirement path of any kind: a venue, once created, was
 * permanent, which is the literal inverse of what a place is supposed to be.
 *
 * ## Soft, and both columns
 *
 * `deleted_at` is what every existing read already filters on, so setting it is
 * what actually removes the venue from the feed, the search and the pickers.
 * `status` is set alongside it because the two would otherwise disagree, and a
 * row saying `active` that no query returns is worse than either state alone.
 *
 * Soft rather than hard, because `events.venue_id` points here: a hard delete
 * either cascades away the history of everything that happened at the place or
 * is refused by the constraint. Retiring a venue must not retire its past.
 */
export async function retireVenue(id: string, reason?: string): Promise<void> {
  const user = await requireUser()
  const venue = await venueForWrite(id, user)

  /*
   * Refused while an event is still to come there.
   *
   * Retiring a venue with a future event booked leaves that event pointing at a
   * place no screen will show, and the organiser finds out at the door. The
   * event has to move first, which is a decision with a person in it.
   */
  const upcoming = await db.events.count({
    where: { venue_id: id, deleted_at: null, end_time: { gte: new Date() } },
  })
  if (upcoming > 0) {
    throw new Error(
      `${upcoming} event${upcoming === 1 ? " is" : "s are"} still booked here. Move or cancel ${upcoming === 1 ? "it" : "them"} first.`
    )
  }

  const { count } = await db.venues.updateMany({
    // Guarded on still being live, so a double submit does not rewrite when.
    where: { id, deleted_at: null },
    data: { deleted_at: new Date(), status: "archived" },
  })
  if (count === 0) throw new Error("That venue is already retired")

  auditLog({
    userId: user.id,
    action: "venue.retired",
    resource: "venue",
    resourceId: id,
    details: { name: venue.name, reason: reason?.trim() || null },
  })
  revalidatePath("/dashboard/venues")
  revalidatePath(`/dashboard/venues/${id}`)
}

/**
 * Put a retired venue back. Admin only.
 *
 * Retiring is reversible and claiming is not, which is why this exists and why
 * it is narrower: an owner can retire their own venue, and only an admin can
 * bring one back, because "this place is open again" is a statement about the
 * catalogue rather than about one organisation.
 */
export async function restoreVenue(id: string): Promise<void> {
  const user = await requireUser()
  if (user.role !== "app_admin") throw new Error("Forbidden")

  const { count } = await db.venues.updateMany({
    where: { id, deleted_at: { not: null } },
    data: { deleted_at: null, status: "active" },
  })
  if (count === 0) throw new Error("That venue is not retired")

  auditLog({
    userId: user.id,
    action: "venue.restored",
    resource: "venue",
    resourceId: id,
  })
  revalidatePath("/dashboard/venues")
  revalidatePath(`/dashboard/venues/${id}`)
}

/**
 * Assign an owning organisation to an unclaimed venue. Admin only.
 *
 * The admin-side counterpart to a claim, for when ownership is established over
 * email rather than through the queue. Re-assigning an owned venue is refused —
 * that is a dispute, and a dispute has a person in it.
 */
export async function assignVenueOwner(venueId: string, orgId: string): Promise<void> {
  const user = await requireUser()
  if (user.role !== "app_admin") throw new Error("Forbidden")

  const venue = await db.venues.findUnique({
    where: { id: venueId, deleted_at: null },
    select: { name: true, owner_org_id: true },
  })
  if (!venue) throw new Error("Venue not found")

  // Layer 3.
  if (venue.owner_org_id && venue.owner_org_id !== orgId) {
    throw new Error(
      "This venue already has an owner. Resolve it as a dispute rather than reassigning silently."
    )
  }

  await db.venues.update({
    where: { id: venueId },
    data: { owner_org_id: orgId, claimed_at: new Date() },
  })

  auditLog({
    userId: user.id,
    action: "venue.owner_assigned",
    resource: "venue",
    resourceId: venueId,
    details: { orgId, venue: venue.name },
  })
  revalidatePath("/dashboard/venue-owners")
  revalidatePath(`/dashboard/venues/${venueId}`)
}

export interface VenueOption {
  id: string
  name: string
  venueTypeLabel: string
  address: string | null
  city: string | null
  lat: number | null
  lng: number | null
  capacity: number | null
  geofence: unknown
  claimed: boolean
}

/**
 * Venues an organiser can pick from when creating an event.
 *
 * Picking one is what makes the event form stop re-asking for a building's
 * address, capacity and check-in area — six of the ten venue-shaped fields on
 * the form describe a building that does not move.
 *
 * Deliberately unscoped by ownership: an organiser holding a night at someone
 * else's brewery must be able to find it. What picking grants the *owner* is
 * handled by `venue_link_status`, not by hiding the venue.
 */
export async function searchVenues(query: string): Promise<VenueOption[]> {
  await requireUser()

  const q = query.trim()
  if (q.length < 2) return []

  const venues = await db.venues.findMany({
    where: {
      deleted_at: null,
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { address: { contains: q, mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      name: true,
      venue_type: true,
      address: true,
      city: true,
      latitude: true,
      longitude: true,
      capacity: true,
      geofence: true,
      owner_org_id: true,
    },
    orderBy: { name: "asc" },
    take: 8,
  })

  return venues.map((v) => ({
    id: v.id,
    name: v.name,
    venueTypeLabel: venueTypeLabel(v.venue_type),
    address: v.address,
    city: v.city,
    lat: v.latitude,
    lng: v.longitude,
    capacity: v.capacity,
    geofence: v.geofence,
    // Shown so an organiser knows the owner will see this event's operational
    // side. Who that owner *is* stays hidden — that would be a customer list.
    claimed: v.owner_org_id !== null,
  }))
}

/** Re-hydrate the picker when an existing event is opened for editing. */
export async function venueById(id: string): Promise<VenueOption | null> {
  await requireUser()
  const v = await db.venues.findUnique({
    where: { id, deleted_at: null },
    select: {
      id: true,
      name: true,
      venue_type: true,
      address: true,
      city: true,
      latitude: true,
      longitude: true,
      capacity: true,
      geofence: true,
      owner_org_id: true,
    },
  })
  if (!v) return null
  return {
    id: v.id,
    name: v.name,
    venueTypeLabel: venueTypeLabel(v.venue_type),
    address: v.address,
    city: v.city,
    lat: v.latitude,
    lng: v.longitude,
    capacity: v.capacity,
    geofence: v.geofence,
    claimed: v.owner_org_id !== null,
  }
}
