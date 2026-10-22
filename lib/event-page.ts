import { notFound, redirect } from "next/navigation"

import { getAuth } from "./auth"
import { curationSelect } from "./curation"
import { db } from "./db"
import { eventDisplayTitle } from "./event-kind"
import { actorFor } from "./org-membership"
import { eventPermissions } from "./rbac"

/**
 * What every page under one event loads first: the event, and what the viewer
 * may do with it (step 15).
 *
 * The overview, the Room chat and the Feedback pages are three routes under one
 * header and one set of tabs, so they ask the same question the same way — the
 * Room page used to gate on `canEdit` while the tab that led there offered it
 * on `canOperate`, and a venue owner landed on another event's chatroom.
 *
 * `curationSelect` already claims `start_time`, `end_time` and
 * `organizer_org_id`, so they are not named again here
 * (`select-fragment-collision.test.ts`).
 */
const eventPageSelect = {
  ...curationSelect,
  id: true,
  title: true,
  status: true,
  created_at: true,
  timezone: true,
  venue_name: true,
  city: true,
  organizer_id: true,
  kind: true,
  venue: { select: { name: true, owner_org_id: true, claimed_at: true } },
} as const

/**
 * The event and the viewer's permissions, or a redirect.
 *
 * Gated on `canOperate`, deliberately, and not on `canEdit`: a venue owner
 * cannot edit an event in their building but has every reason to open it — the
 * live view, the attendee count, the chatroom. Gating on canEdit locked them
 * out of the event entirely, which is the bug the operational bucket exists to
 * prevent. What `canEdit` buys is decided per tab.
 */
export async function loadEventPage(id: string) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  const event = await db.events.findFirst({ where: { id, deleted_at: null }, select: eventPageSelect })
  if (!event) notFound()

  const actor = await actorFor(session.user)
  const permissions = eventPermissions(actor, event)
  if (!permissions.canOperate) redirect("/dashboard/events")
  // A venue day's internal title never reaches the page (PL-I16).
  return { event: { ...event, title: eventDisplayTitle(event) }, actor, permissions }
}

export type EventPageData = Awaited<ReturnType<typeof loadEventPage>>
