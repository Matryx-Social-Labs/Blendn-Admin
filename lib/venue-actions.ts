"use server"

import { isDeepStrictEqual } from "node:util"
import { Refusal } from "./refusal"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { auditLog } from "@/lib/audit-log"
import { haversineDistanceMeters } from "@/lib/geo"
import { fenceCentre, validateGeofence, type Geofence } from "@/lib/geofence"
import { GEOFENCE_MESSAGES } from "@/lib/geofence-input"

/**
 * How far a fence's centre may sit from the venue's pin.
 *
 * A fence describes the venue; the pin *is* the venue. When the two drift the
 * door is judged against a place nobody is standing at, and every check-in
 * there is refused with a distance in the hundreds of metres. It happened
 * from the editor itself (SCRUM-203: "Trace outline" jumped the map to the
 * city centre), and it can happen from any client, so the write refuses it.
 * 500 m is generous for the largest venue on the platform and still a
 * different street for the smallest.
 */
const FENCE_DRIFT_LIMIT_METRES = 500

function refuseIfFenceDrifted(fence: Geofence, pin: { lat: number; lng: number }): void {
  const centre = fenceCentre(fence)
  if (!centre) return
  const metres = haversineDistanceMeters(pin.lat, pin.lng, centre.lat, centre.lng)
  if (metres > FENCE_DRIFT_LIMIT_METRES) {
    throw new Refusal(
      `The check-in area is ${Math.round(metres)} m from the venue's pin. Draw it around the venue, or move the pin.`
    )
  }
}
import { VENUE_TYPES, venueTypeLabel } from "@/lib/venue-types"
import { defaultVenueFence, nearbyVenues, type NearbyVenue } from "@/lib/venue-rules"
import { type venue_type } from "@prisma/client"
import { homeOrgIdFor } from "@/lib/event-ownership"
import { activeMembership } from "@/lib/org-membership"
import { overUserLimit } from "@/lib/rate-limit"
import { realEventsWhere } from "@/lib/event-kind"

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

async function requireUser() {
  const session = await getAuth()
  if (!session?.user) throw new Refusal("Unauthorized")
  return session.user
}

/**
 * What already exists near this pin.
 *
 * Called before a create, so the answer to "add The Loft" can be "The Loft is
 * already here — claim it" rather than a second row nobody reconciles.
 */
export async function venuesNear(lat: number, lng: number): Promise<NearbyVenue[]> {
  const user = await requireUser()
  // Asked on every pick and pin move; a script asking faster than a person
  // drags is mapping the directory (SCRUM-360). The create path below asks
  // through `nearbyVenues` and is limited as a create instead.
  if (await overUserLimit("write", "venues-near", user.id)) {
    throw new Refusal("Too many look-ups at once. Wait a minute and try again.")
  }
  return nearbyVenues(lat, lng, user.role === "app_admin")
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
  /**
   * Unclaimed whoever adds it: the event form saves the place an event is at
   * (SCRUM-353c), which is not a venue owner describing their own place.
   */
  asUnclaimed?: boolean
}

/**
 * Create a venue.
 *
 * An admin creates unclaimed records. A venue owner creates a venue **already
 * owned by their organisation** — they are describing their own place, and
 * making them create-then-claim it would be ceremony with no safety value.
 *
 * An organiser adds an **unclaimed** venue (SCRUM-352): the place they are
 * holding an event at, saved once so nobody draws its outline again. Unclaimed
 * grants nobody control over anybody's events — that only comes with a claim,
 * which a person reviews — so this is safe. `created_by_org_id` records their
 * organisation, which may edit the venue until someone claims it.
 */
export async function createVenue(input: CreateVenueInput): Promise<{ id: string }> {
  const user = await requireUser()
  if (user.role !== "app_admin" && user.role !== "venue_owner" && user.role !== "organizer") {
    throw new Refusal("Forbidden")
  }
  // Every event save with a newly picked place lists one (SCRUM-353c); ten a
  // minute is more places than a person adds, and fewer than a script would.
  if (await overUserLimit("heavy", "venue-create", user.id)) {
    throw new Refusal("Too many venues added at once. Wait a minute and try again.")
  }

  const name = input.name.trim()
  if (name.length < 2) throw new Refusal("Give the venue a name.")
  refuseUnknownVenueType(input.venueType)
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) {
    throw new Refusal("Place the venue on the map first.")
  }

  // Layer 1. Refused rather than warned, because the caller has already been
  // shown the neighbours by `venuesNear` and has to say it meant it.
  if (!input.acknowledgedDuplicates) {
    const nearby = await nearbyVenues(input.lat, input.lng, user.role === "app_admin")
    if (nearby.length > 0) {
      throw new Refusal(
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
    if (!parsed.ok) throw new Refusal(GEOFENCE_MESSAGES[parsed.error])
    refuseIfFenceDrifted(parsed.fence, { lat: input.lat, lng: input.lng })
    geofence = parsed.fence
  } else {
    geofence = defaultVenueFence(input.lat, input.lng, input.venueType)
  }

  // The same "my org" as event creation: oldest live membership (SCRUM-148).
  const orgId = user.role === "app_admin" ? null : await homeOrgIdFor(user)

  if (user.role !== "app_admin" && !orgId) {
    throw new Refusal("Your account is not attached to an organisation yet.")
  }
  // A venue owner describes their own place; an organiser adds one unclaimed,
  // and so does anyone saving the place of an event.
  const ownerOrgId = user.role === "venue_owner" && !input.asUnclaimed ? orgId : null

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
      owner_org_id: ownerOrgId,
      claimed_at: ownerOrgId ? new Date() : null,
      created_by: user.id,
      created_by_org_id: orgId,
    },
    select: { id: true },
  })

  auditLog({
    userId: user.id,
    action: "venue.created",
    resource: "venue",
    resourceId: venue.id,
    details: { name, venueType: input.venueType, claimed: !!ownerOrgId, createdByOrgId: orgId },
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
  /**
   * How many floors the app's map draws the building with (owner, 2026-10-09).
   * Null clears it. The owner's organisation or an admin only: the organisation
   * that added an unclaimed venue corrects the place, not how it stands on the
   * map.
   */
  floors?: number | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The building's floors, as the CHECK `venues_floors_range` allows. */
const MAX_FLOORS = 200

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
  // A server action's argument is whatever the client sent: not a uuid is not found, not a 500.
  if (!UUID.test(id)) throw new Refusal("Venue not found")
  const venue = await db.venues.findUnique({
    where: { id, deleted_at: null },
    select: { id: true, name: true, owner_org_id: true, created_by_org_id: true },
  })
  if (!venue) throw new Refusal("Venue not found")

  if (user.role !== "app_admin") {
    // The owner's organisation once claimed; until then, the organisation
    // that added it (owner's ruling 2, SCRUM-352). Never both: a claim hands
    // the venue over.
    const orgId = venue.owner_org_id ?? venue.created_by_org_id
    const member = orgId
      ? await db.organisation_members.findFirst({
          where: { user_id: user.id, org_id: orgId, ...activeMembership },
          select: { id: true },
        })
      : null
    if (!member) throw new Refusal("Forbidden")
  }
  return { id: venue.id, name: venue.name, owner_org_id: venue.owner_org_id }
}

/**
 * A server action's caller is any client, typed or not: a venue type outside
 * the vocabulary is refused here rather than handed to Prisma to throw on.
 */
function refuseUnknownVenueType(type: venue_type | null | undefined): void {
  if (type != null && !VENUE_TYPES.includes(type)) throw new Refusal("That is not a venue type this list knows.")
}

/** The form's name for each column an update writes, as the audit row records it. */
const FORM_FIELD = {
  name: "name",
  venue_type: "venueType",
  address: "address",
  city: "city",
  capacity: "capacity",
  latitude: "lat",
  longitude: "lng",
  geofence: "geofence",
  floors: "floors",
} as const

/** A polygon's corner count, "circle", or null for no outline. */
function fenceShape(value: unknown): number | "circle" | null {
  const parsed = validateGeofence(value)
  if (!parsed.ok || !parsed.fence) return null
  return parsed.fence.type === "polygon" ? parsed.fence.ring.length : "circle"
}

/**
 * Edit a venue. Owners edit their own; admins edit any.
 *
 * Not rate limited, deliberately (SCRUM-360): an edit reaches only venues the
 * caller's organisation may write, so it cannot flood the directory or map it
 * the way a create or a look-up can.
 */
export async function updateVenue(id: string, input: UpdateVenueInput): Promise<void> {
  const user = await requireUser()
  const writable = await venueForWrite(id, user)
  refuseUnknownVenueType(input.venueType)
  if (input.floors !== undefined) {
    if (user.role !== "app_admin" && !writable.owner_org_id) {
      throw new Refusal("Only the venue's owner or an admin sets its floors.")
    }
    if (input.floors !== null && (!Number.isInteger(input.floors) || input.floors < 1 || input.floors > MAX_FLOORS)) {
      throw new Refusal(`Floors is a whole number from 1 to ${MAX_FLOORS}, or empty.`)
    }
  }

  /*
   * Both or neither, checked before anything is written. Half a coordinate pair
   * would move the venue to the equator or the prime meridian rather than
   * failing, which is a wrong answer that looks like a working save.
   */
  const movingPin = input.lat !== undefined || input.lng !== undefined
  if (movingPin && (input.lat === undefined || input.lng === undefined)) {
    throw new Refusal("Give both a latitude and a longitude, or neither.")
  }
  if (movingPin) {
    const { lat, lng } = input as { lat: number; lng: number }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new Refusal("Latitude must be between -90 and 90.")
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new Refusal("Longitude must be between -180 and 180.")
    }
  }

  // The row as it stands: the drift checks below read it, and the audit says what changed from it.
  const before = await db.venues.findUniqueOrThrow({
    where: { id },
    select: {
      name: true,
      venue_type: true,
      address: true,
      city: true,
      capacity: true,
      latitude: true,
      longitude: true,
      geofence: true,
      floors: true,
    },
  })

  let geofence: Geofence | undefined
  if (input.geofence !== undefined) {
    const parsed = validateGeofence(input.geofence)
    if (!parsed.ok) throw new Refusal(GEOFENCE_MESSAGES[parsed.error])
    if (parsed.fence) {
      // Against the pin as it will be after this request.
      const pin = movingPin
        ? (input as { lat: number; lng: number })
        : before.latitude !== null && before.longitude !== null
          ? { lat: before.latitude, lng: before.longitude }
          : null
      // A venue with no pin yet has nothing for the fence to drift from.
      if (pin) refuseIfFenceDrifted(parsed.fence, pin)
    }
    geofence = parsed.fence
  } else if (movingPin) {
    /*
     * The pin can move on its own — the venue page's other supported edit —
     * and the stored fence stays exactly where it was. Moving the pin across
     * town therefore drifted the door by the whole distance, unchecked,
     * because the drift test only ran on a fence that came with the request
     * (SCRUM-204). Same limit, same message, against what is already stored.
     */
    const existing = validateGeofence(before.geofence)
    if (existing.ok && existing.fence) {
      refuseIfFenceDrifted(existing.fence, input as { lat: number; lng: number })
    }
  }

  const data = {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.venueType !== undefined ? { venue_type: input.venueType } : {}),
    ...(input.address !== undefined ? { address: input.address?.trim() || null } : {}),
    ...(input.city !== undefined ? { city: input.city?.trim() || null } : {}),
    ...(input.capacity !== undefined
      ? { capacity: input.capacity && input.capacity > 0 ? Math.round(input.capacity) : null }
      : {}),
    ...(geofence ? { geofence: geofence as object } : {}),
    ...(movingPin ? { latitude: input.lat, longitude: input.lng } : {}),
    ...(input.floors !== undefined ? { floors: input.floors } : {}),
  }
  await db.venues.update({ where: { id }, data })

  /*
   * What changed, not what was sent (SCRUM-423). The manage form sends every
   * field on each save, so an outline-only edit was recorded as name, type,
   * address, city, capacity, lat, lng and geofence. A save that changes nothing
   * writes no row.
   */
  const changed = (Object.keys(data) as (keyof typeof data)[]).filter(
    // Deep, not by JSON text: jsonb hands the stored outline back with its keys reordered.
    (column) => !isDeepStrictEqual(data[column], before[column])
  )
  if (changed.length > 0) {
    auditLog({
      userId: user.id,
      action: "venue.updated",
      resource: "venue",
      resourceId: id,
      details: {
        fields: changed.map((column) => FORM_FIELD[column]),
        // The outline's shape either side, so a disputed door can be traced.
        ...(changed.includes("geofence") ? { geofence: { before: fenceShape(before.geofence), after: fenceShape(geofence) } } : {}),
      },
    })
  }
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
  // The organisation that added an unclaimed venue corrects it; it does not
  // take it out of every other organiser's list (SCRUM-361). An owner or an
  // admin retires.
  if (user.role !== "app_admin" && !venue.owner_org_id) {
    throw new Refusal("Only an admin retires a venue nobody has claimed.")
  }

  /*
   * Refused while an event is still to come there.
   *
   * Retiring a venue with a future event booked leaves that event pointing at a
   * place no screen will show, and the organiser finds out at the door. The
   * event has to move first, which is a decision with a person in it.
   *
   * A cancelled event is not booked: the refusal says "move or cancel it", and
   * cancelling it has to be enough (SCRUM-424). `status` is NOT NULL, so `not`
   * hides no row.
   */
  const upcoming = await db.events.count({
    // Hosts' bookings. The venue's own live room for today is not one, and
    // would make every venue anybody went live at today impossible to retire.
    where: { venue_id: id, deleted_at: null, ...realEventsWhere, end_time: { gte: new Date() }, status: { not: "cancelled" } },
  })
  if (upcoming > 0) {
    throw new Refusal(
      `${upcoming} event${upcoming === 1 ? " is" : "s are"} still booked here. Move or cancel ${upcoming === 1 ? "it" : "them"} first.`
    )
  }

  const { count } = await db.venues.updateMany({
    // Guarded on still being live, so a double submit does not rewrite when.
    where: { id, deleted_at: null },
    data: { deleted_at: new Date(), status: "archived" },
  })
  if (count === 0) throw new Refusal("That venue is already retired")

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
  if (user.role !== "app_admin") throw new Refusal("Forbidden")

  const { count } = await db.venues.updateMany({
    where: { id, deleted_at: { not: null } },
    data: { deleted_at: null, status: "active" },
  })
  if (count === 0) throw new Refusal("That venue is not retired")

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
  if (user.role !== "app_admin") throw new Refusal("Forbidden")

  const venue = await db.venues.findUnique({
    where: { id: venueId, deleted_at: null },
    select: { name: true, owner_org_id: true },
  })
  if (!venue) throw new Refusal("Venue not found")

  // Layer 3.
  if (venue.owner_org_id && venue.owner_org_id !== orgId) {
    throw new Refusal(
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

/** Words that name no venue: "The Humming Tree" is found by "humming" and "tree". */
const SEARCH_STOPWORDS = new Set(["the", "and", "of", "at", "in", "on", "by", "an", "&"])
/** Read before ranking, so a name-sorted page of "Cafe …" rows cannot crowd the best match out. */
const SEARCH_CANDIDATES = 50
const SEARCH_RESULTS = 8

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

  /*
   * By word, not by phrase (SCRUM-362). "Toit Indiranagar" found nothing: the
   * venue is named "Toit" and its address says "Hoysala Nagara", so neither
   * held the whole phrase. A venue with any word in its name is a candidate;
   * the ones matching the most words — in the name first — come back. The
   * whole phrase in the address still counts, for "100 Feet Road".
   */
  const phrase = q.toLowerCase()
  const words = [...new Set(phrase.split(/\s+/))].filter((w) => w.length >= 2 && !SEARCH_STOPWORDS.has(w)).slice(0, 6)
  const terms = words.length ? words : [phrase]

  const candidates = await db.venues.findMany({
    where: {
      deleted_at: null,
      OR: [
        { address: { contains: q, mode: "insensitive" } },
        ...terms.map((w) => ({ name: { contains: w, mode: "insensitive" as const } })),
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
    take: SEARCH_CANDIDATES,
  })

  const score = (v: { name: string; address: string | null; city: string | null }) => {
    const name = v.name.toLowerCase()
    const rest = `${v.address ?? ""} ${v.city ?? ""}`.toLowerCase()
    const byWord = terms.reduce((sum, w) => sum + (name.includes(w) ? 2 : rest.includes(w) ? 1 : 0), 0)
    return byWord + (name.includes(phrase) ? 3 : 0)
  }
  const venues = candidates
    .map((v) => ({ v, s: score(v) }))
    .sort((a, b) => b.s - a.s || a.v.name.localeCompare(b.v.name))
    .slice(0, SEARCH_RESULTS)
    .map(({ v }) => v)

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
