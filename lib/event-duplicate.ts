import type { Prisma, user_role } from "@prisma/client"
import { formatInTimeZone, fromZonedTime } from "date-fns-tz"

import type { EventEditorData } from "@/components/event-editor"
import { isUuid } from "./api-input"
import { db } from "./db"
import { homeOrgIdFor } from "./event-ownership"
import { eventClock } from "./event-phase"
import type { Rendition } from "./media-clip"
import { actorFor } from "./org-membership"
import { eventPermissionSelect, eventPermissions } from "./rbac"

/**
 * "Duplicate" on an event (SCRUM-1153): the New event form, prefilled with
 * next week's night. Nothing is written here; the host saves through the same
 * create route as any new event, so every check runs again.
 *
 * What a weekly night re-enters is copied; guests, the room, announcements,
 * sponsors, tickets and the tickets link, ratings, curation and claims are
 * not, and neither is any column this file does not name: the select below
 * and the mapper are allow-lists.
 *
 * Media point at the source's own objects. Nothing deletes an `events/`
 * object when an event is deleted (a soft delete) or its media are replaced
 * (rows only), so a copy keeps working after its source goes
 * (`__tests__/integration/duplicate-event.itest.ts`).
 *
 * The check-in area is the source's own copy, as it is (advisor pick S): the
 * fence that worked at the door last week, with "Adjust area" there if the
 * venue has moved its own since.
 */
export const duplicateSourceSelect = {
  title: true,
  description: true,
  short_description: true,
  venue_name: true,
  venue_id: true,
  address: true,
  city: true,
  state: true,
  country: true,
  postal_code: true,
  start_time: true,
  end_time: true,
  timezone: true,
  visibility: true,
  max_capacity: true,
  min_age: true,
  door_policy: true,
  latitude: true,
  longitude: true,
  cover_image_url: true,
  crews_enabled: true,
  check_in_radius: true,
  geofence: true,
  details: {
    select: {
      full_description: true,
      house_rules: true,
      cancellation_policy: true,
      additional_info: true,
      faq: true,
      accessibility_info: true,
    },
  },
  categories: { select: { primary: true, category: { select: { id: true } } }, orderBy: { created_at: "asc" } },
  amenities: { select: { amenity_id: true } },
  media: {
    select: {
      type: true,
      url: true,
      thumbnail_url: true,
      title: true,
      description: true,
      order: true,
      width: true,
      height: true,
      duration_ms: true,
      focal_x: true,
      focal_y: true,
      renditions: true,
    },
    orderBy: { order: "asc" },
  },
} satisfies Prisma.eventsSelect

export type DuplicateSource = Prisma.eventsGetPayload<{ select: typeof duplicateSourceSelect }>

export interface DuplicatePrefill {
  initialEvent: EventEditorData
  /** Whole weeks the dates moved: one, or more when the source is in the past. */
  weeks: number
  /** What the form says above itself: the first sentence bold, the rest muted. */
  note: { lead: string; rest: string }
}

const WEEK_MS = 7 * 86_400_000

/** The same wall-clock time `weeks` calendar weeks later on `zone`'s clock: 21:00 stays 21:00 across DST. */
function weeksLater(at: Date, zone: string, weeks: number): Date {
  const [day, time] = formatInTimeZone(at, zone, "yyyy-MM-dd HH:mm:ss.SSS").split(" ")
  const moved = new Date(Date.parse(`${day}T00:00:00Z`) + weeks * WEEK_MS).toISOString().slice(0, 10)
  return fromZonedTime(`${moved}T${time}`, zone)
}

const REST =
  "Nothing is saved until you publish or save a draft. Guests, the room, announcements, sponsors and tickets stay with the original, and this is a single event, not a series."

export function duplicatePrefill(source: DuplicateSource, now: Date): DuplicatePrefill {
  const clock = eventClock(source.timezone)
  // At least a week, then whole weeks until the start is ahead. `floor` never overshoots: a DST hour moves a shifted start by one hour, never a week.
  let weeks = Math.max(1, Math.floor((now.getTime() - source.start_time.getTime()) / WEEK_MS))
  while (weeksLater(source.start_time, clock.zone, weeks) <= now) weeks++
  const start = weeksLater(source.start_time, clock.zone, weeks)
  const end = weeksLater(source.end_time, clock.zone, weeks)

  const year = (d: Date) => clock.format(d, { year: "numeric" })
  const withYear = year(source.start_time) !== year(start)
  // Two parts: en-GB puts a comma after the weekday once a year is in ("Sat, 26 Dec 2026").
  const day = (d: Date) =>
    `${clock.format(d, { weekday: "short" })} ${clock.format(d, { day: "numeric", month: "short", ...(withYear && { year: "numeric" }) })}`
  const to = `${day(start)}, ${clock.time(start)}`
  const lead =
    weeks === 1
      ? `A copy of your ${day(source.start_time)} event, moved one week later to ${to}.`
      : `A copy of your ${day(source.start_time)} event, moved ${weeks} weeks later to the next ${clock.format(start, { weekday: "long" })} ahead: ${to}.`

  const { details } = source
  return {
    weeks,
    note: { lead, rest: REST },
    initialEvent: {
      title: source.title,
      description: source.description,
      full_description: details?.full_description ?? source.description,
      short_description: source.short_description,
      venue_name: source.venue_name,
      venue_id: source.venue_id,
      address: source.address,
      city: source.city,
      state: source.state,
      country: source.country,
      postal_code: source.postal_code,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      timezone: source.timezone,
      status: "draft",
      visibility: source.visibility,
      max_capacity: source.max_capacity,
      min_age: source.min_age,
      door_policy: source.door_policy,
      latitude: source.latitude,
      longitude: source.longitude,
      cover_image_url: source.cover_image_url,
      crews_enabled: source.crews_enabled,
      check_in_radius: source.check_in_radius,
      geofence: source.geofence ?? undefined,
      category_ids: source.categories.map((c) => c.category.id),
      amenity_ids: source.amenities.map((a) => a.amenity_id),
      primary_category_id: source.categories.find((c) => c.primary)?.category.id ?? null,
      house_rules: details?.house_rules ?? null,
      cancellation_policy: details?.cancellation_policy ?? null,
      additional_info: details?.additional_info ?? undefined,
      faq: details?.faq ?? undefined,
      accessibility_info: details?.accessibility_info ?? undefined,
      // The select names each column, so a spread passes only those. Renditions are written only through `eventMediaRows`.
      media_items: source.media.map((m) => ({ ...m, renditions: m.renditions as Rendition[] | null })),
    },
  }
}

/**
 * The prefill for `?from=<id>`, or null: no uuid, no such event, a deleted
 * one, a venue day, one this person may not edit, or one of an organisation
 * a new event of theirs would not belong to all read the same, so a stranger
 * learns nothing about an id.
 */
export async function duplicateFor(
  user: { id: string; role: user_role },
  from: unknown,
  now = new Date()
): Promise<DuplicatePrefill | null> {
  if (!isUuid(from)) return null
  const source = await db.events.findFirst({
    where: { id: from, deleted_at: null, kind: "event" },
    // The resolver's fragment last, so its columns are its own; the one overlap, `start_time`, is `true` in both.
    select: { ...duplicateSourceSelect, ...eventPermissionSelect },
  })
  if (!source || !eventPermissions(await actorFor(user), source).canEdit) return null
  // The save puts the copy in this person's home org (`owningOrgFor`), so only that org's events are offered:
  // a copy always lands where its source is, never in a second org with the first one's venue (code review).
  if (source.organizer_org_id !== (await homeOrgIdFor(user))) return null
  return duplicatePrefill(source, now)
}
