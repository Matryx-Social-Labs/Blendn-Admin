import { cityRuleWhere, viewerCityRule } from "@/lib/browse-scope"
import { ageFrom, isAdult, mayParticipate, minAgeRefusal } from "@/lib/age"
import { db } from "@/lib/db"
import { eventDisplayTitle, inRoomWhere, realEventsWhere, venueDaysWhere } from "@/lib/event-kind"
import {
  DEFAULT_ACCURACY_POLICY,
  evaluateCheckIn,
  fenceSelect,
  GEOFENCE_LIMITS,
  resolveFence,
  type Geofence,
  type LatLng,
} from "@/lib/geofence"
import { CHECK_IN_LEAD_MINUTES, pickOccurrence } from "@/lib/occurrences"
import { canJoinEvent } from "@/lib/socket-auth"
import { MAX_GPS_ACCURACY_METERS } from "@/lib/validations/event"
import { goLiveArea, venuesTakenOver } from "@/lib/venue-visibility"

/**
 * Which places am I inside? (SCRUM-704)
 *
 * The phone guessed: the nearest pin within 100 m lit the disc and docked the
 * pass, while each door judged the real fence. So the disc stayed dark at a
 * door that would admit you, lit at one that would refuse you, and two places
 * at once had no answer at all. This is the server's answer, judged the way
 * the doors judge — the same fence (`resolveFence`; a venue's `goLiveArea`),
 * the same accuracy allowance (`evaluateCheckIn`), the same day
 * (`pickOccurrence`) and the same people rules (participation, age, a private
 * event's guest list, a venue an event has taken over) — so the disc lights
 * exactly where a check-in would succeed.
 *
 * In a fixed order, the first being the one the pass docks:
 *
 *   1. an event you're going to or saved;
 *   2. an event before a venue (a venue day);
 *   3. among events, the one whose day started first;
 *   4. the nearest.
 *
 * `current` is the room you're in now, so the app can say "Checking in here
 * takes you out of {A}." before the hold, not after (SCRUM-635).
 */

export interface PlaceInside {
  kind: "event" | "venue"
  /**
   * The event; always null for a venue. A venue's day is not offered by id:
   * its door is Go Live by `venueId` (a venue day's id refuses the event door,
   * and nothing else needs it here — review M1).
   */
  eventId: string | null
  venueId: string | null
  name: string
  /** The event's own venue line; null for a venue (its name is `name`). */
  venueName: string | null
  /** The event's day; null for a venue. */
  startTime: Date | null
  endTime: Date | null
  /** Your RSVP is `going`. Events only. */
  going: boolean
  saved: boolean
  /** You are checked in here now. */
  checkedIn: boolean
}

export interface CurrentRoom {
  eventId: string
  kind: "event" | "venue_day"
  venueId: string | null
  name: string
}

export interface PlacesInside {
  places: PlaceInside[]
  total: number
  current: CurrentRoom | null
}

/** Places returned at most. Being inside more than a handful at once is a mall; the count says how many. */
export const MAX_PLACES_INSIDE = 10

/**
 * How far a fence can reach from its pin: the largest circle, the largest
 * buffer and the largest accuracy allowance. Anything further is outside
 * every door, so the reads never leave a box this size around the person.
 */
export const PLACE_REACH_M = GEOFENCE_LIMITS.MAX_RADIUS + GEOFENCE_LIMITS.MAX_BUFFER + DEFAULT_ACCURACY_POLICY.cap

/** Candidates read at most per kind; a box of this size in a city holds far fewer that are open now. */
const CANDIDATE_CEILING = 500

const METRES_PER_DEG_LAT = 111_320

function box(point: LatLng) {
  const dLat = PLACE_REACH_M / METRES_PER_DEG_LAT
  const dLng = PLACE_REACH_M / (METRES_PER_DEG_LAT * Math.max(Math.cos((point.lat * Math.PI) / 180), 0.01))
  return {
    latitude: { gte: point.lat - dLat, lte: point.lat + dLat },
    longitude: { gte: point.lng - dLng, lte: point.lng + dLng },
  }
}

interface Ranked extends PlaceInside {
  distance: number
}

const inside = (fence: Geofence | null, point: LatLng, accuracy: number | undefined) =>
  fence ? evaluateCheckIn(point, fence, accuracy) : null

export async function placesInside(
  userId: string,
  point: LatLng,
  accuracy: number | undefined,
  now: Date = new Date()
): Promise<PlacesInside> {
  const [profile, currentRow] = await Promise.all([
    db.profiles.findUnique({ where: { id: userId }, select: { onboarded: true, age: true, date_of_birth: true } }),
    db.event_check_ins.findFirst({
      where: { user_id: userId, status: "checked_in", ...inRoomWhere(userId, now) },
      orderBy: { check_in_time: "desc" },
      select: { event: { select: { id: true, kind: true, title: true, venue_id: true, venue_name: true, venue: { select: { name: true } } } } },
    }),
  ])
  const current: CurrentRoom | null = currentRow
    ? {
        eventId: currentRow.event.id,
        kind: currentRow.event.kind,
        venueId: currentRow.event.venue_id,
        name: eventDisplayTitle(currentRow.event),
      }
    : null

  // Nobody the doors would let in anywhere — or a fix they refuse as too vague — is inside nothing.
  const vague = accuracy !== undefined && accuracy > MAX_GPS_ACCURACY_METERS
  if (vague || !mayParticipate(profile)) return { places: [], total: 0, current }
  const age = ageFrom(profile)

  // A closed city's rows are not offered: the gate the lists and the by-id reads use.
  const cityWhere = cityRuleWhere(await viewerCityRule(userId, undefined))
  const [events, venues] = await Promise.all([eventsInside(userId, cityWhere, point, accuracy, age, now), isAdult(age) ? venuesInside(cityWhere, point, accuracy, age, now) : []])
  // Where you are now: an event by its id; a venue by the venue your live day is at.
  const here = (p: Ranked) =>
    p.kind === "venue" ? current?.kind === "venue_day" && current.venueId === p.venueId : p.eventId === current?.eventId
  const all: Ranked[] = [...events, ...venues].map((p) => ({ ...p, checkedIn: here(p) }))

  // The order the pass docks in (SCRUM-704).
  all.sort(
    (a, b) =>
      Number(b.going || b.saved) - Number(a.going || a.saved) ||
      Number(a.kind === "venue") - Number(b.kind === "venue") ||
      (a.startTime?.getTime() ?? 0) - (b.startTime?.getTime() ?? 0) ||
      a.distance - b.distance
  )
  return {
    places: all.slice(0, MAX_PLACES_INSIDE).map(({ distance: _distance, ...place }) => place),
    total: all.length,
    current,
  }
}

type CityWhere = ReturnType<typeof cityRuleWhere>

async function eventsInside(userId: string, cityWhere: CityWhere, point: LatLng, accuracy: number | undefined, age: number | null, now: Date): Promise<Ranked[]> {
  const lead = new Date(now.getTime() + CHECK_IN_LEAD_MINUTES * 60_000)
  const rows = await db.events.findMany({
    where: {
      ...realEventsWhere,
      deleted_at: null,
      status: "published",
      start_time: { lte: lead },
      end_time: { gte: now },
      // A polygon-only event may have no pin: kept for the fence test rather than lost to the box.
      OR: [box(point), { latitude: null }, { longitude: null }],
      occurrences: { some: { start_time: { lte: lead }, end_time: { gte: now } } },
      AND: [cityWhere],
    },
    take: CANDIDATE_CEILING,
    select: {
      id: true,
      title: true,
      kind: true,
      venue_name: true,
      visibility: true,
      min_age: true,
      ...fenceSelect,
      occurrences: {
        orderBy: { start_time: "asc" },
        select: { id: true, occurs_on: true, start_time: true, end_time: true, capacity: true, cancelled_at: true },
      },
      rsvps: { where: { user_id: userId, status: "going" }, select: { id: true } },
      favorites: { where: { user_id: userId }, select: { id: true } },
    },
  })

  const out: Ranked[] = []
  for (const e of rows) {
    // The door's day, cancelled days and all.
    const slots = e.occurrences.map((o) => ({
      id: o.id,
      occursOn: o.occurs_on,
      startTime: o.start_time,
      endTime: o.end_time,
      capacity: o.capacity,
      cancelledAt: o.cancelled_at,
    }))
    const day = pickOccurrence(slots, now)
    if (!day.ok) continue
    const verdict = inside(resolveFence(e), point, accuracy)
    if (!verdict?.ok) continue
    if (minAgeRefusal(age, e.min_age)) continue
    // Bounded: only a private event that already passed the fence is asked about.
    if (e.visibility === "private" && !(await canJoinEvent(userId, e.id))) continue
    out.push({
      kind: "event",
      eventId: e.id,
      venueId: null,
      name: eventDisplayTitle(e),
      venueName: e.venue_name,
      startTime: day.occurrence.startTime,
      endTime: day.occurrence.endTime,
      going: e.rsvps.length > 0,
      saved: e.favorites.length > 0,
      checkedIn: false,
      distance: verdict.distance,
    })
  }
  return out
}

async function venuesInside(cityWhere: CityWhere, point: LatLng, accuracy: number | undefined, age: number | null, now: Date): Promise<Ranked[]> {
  const venues = await db.venues.findMany({
    where: { deleted_at: null, status: "active", ...box(point), AND: [cityWhere] },
    take: CANDIDATE_CEILING,
    select: { id: true, name: true, geofence: true },
  })
  if (venues.length === 0) return []
  const ids = venues.map((v) => v.id)

  // Today's day at each, in one read (`venueDayAt` for many): its copied area is the one Go Live judges.
  const [days, takenOver] = await Promise.all([
    db.events.findMany({
      where: { ...venueDaysWhere, venue_id: { in: ids }, start_time: { lte: now }, end_time: { gt: now } },
      orderBy: { start_time: "desc" },
      select: { id: true, venue_id: true, geofence: true, deleted_at: true },
    }),
    // An event has the venue: Go Live there is refused for it (`EVENT_LIVE_HERE`).
    venuesTakenOver(now, { id: { in: ids } }, { viewerAge: age }),
  ])
  const dayOf = new Map<string, (typeof days)[number]>()
  for (const d of days) if (d.venue_id && !dayOf.has(d.venue_id)) dayOf.set(d.venue_id, d)
  const taken = new Set(takenOver)

  const out: Ranked[] = []
  for (const v of venues) {
    const day = dayOf.get(v.id) ?? null
    // A deleted day stays deleted for the day: Go Live answers 404.
    if (taken.has(v.id) || day?.deleted_at) continue
    const verdict = inside(goLiveArea(day, v), point, accuracy)
    if (!verdict?.ok) continue
    out.push({
      kind: "venue",
      eventId: null,
      venueId: v.id,
      name: v.name,
      venueName: null,
      startTime: null,
      endTime: null,
      going: false,
      saved: false,
      checkedIn: false,
      distance: verdict.distance,
    })
  }
  return out
}
