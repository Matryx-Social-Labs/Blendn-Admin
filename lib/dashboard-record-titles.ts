import { cache } from "react"

import { getAuth } from "./auth"
import { db } from "./db"
import { eventDisplayTitle } from "./event-kind"
import { activeMembership, actorFor } from "./org-membership"
import { eventPermissionSelect, eventPermissions } from "./rbac"

/**
 * A record's name for the document `<title>` of its page (WCAG 2.4.2), or
 * `null` for somebody who may not see it.
 *
 * `generateMetadata` runs beside the page, not after it, so it cannot lean on
 * the page's own redirect: a title read without the page's check would put an
 * event's name in the tab of somebody the page then refuses. Each loader here
 * applies the page's rule, and returns null — the caller then titles the tab by
 * the route's kind ("Event") — rather than leak the name.
 *
 * `cache` makes it one query per request however many callers ask.
 */

/** The event pages: anyone the event page itself lets in (`canOperate`). */
export const eventTitleFor = cache(async (id: string): Promise<string | null> => {
  const session = await getAuth()
  if (!session?.user) return null
  const event = await db.events.findFirst({
    where: { id, deleted_at: null },
    select: { title: true, venue_name: true, ...eventPermissionSelect },
  })
  if (!event) return null
  const actor = await actorFor(session.user)
  return eventPermissions(actor, event).canOperate
    ? eventDisplayTitle({ kind: event.kind, title: event.title, venue_name: event.venue_name })
    : null
})

/**
 * The venue pages: an admin, a member of the owning organisation, or — while
 * nobody has claimed it — a member of the organisation that added it.
 */
export const venueTitleFor = cache(async (id: string): Promise<string | null> => {
  const session = await getAuth()
  if (!session?.user) return null
  const venue = await db.venues.findUnique({
    where: { id },
    select: { name: true, owner_org_id: true, created_by_org_id: true, deleted_at: true },
  })
  if (!venue) return null
  if (session.user.role === "app_admin") return venue.name
  const orgId = venue.owner_org_id ?? (venue.deleted_at ? null : venue.created_by_org_id)
  if (!orgId) return null
  const member = await db.organisation_members.findFirst({
    where: { user_id: session.user.id, org_id: orgId, ...activeMembership },
    select: { id: true },
  })
  return member ? venue.name : null
})

/** The organiser and venue-owner account pages: admins only, as the pages are. */
export const accountTitleFor = cache(async (id: string): Promise<string | null> => {
  const session = await getAuth()
  if (session?.user?.role !== "app_admin") return null
  const user = await db.user.findUnique({ where: { id }, select: { name: true, email: true } })
  return user ? (user.name ?? user.email) : null
})
