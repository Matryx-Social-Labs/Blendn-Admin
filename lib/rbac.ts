import type { user_role } from "@prisma/client"

export function canAccessDashboard(role: user_role): boolean {
  return role === "app_admin" || role === "organizer" || role === "venue_owner"
}

export function canSendSystemMessages(role: user_role): boolean {
  return role === "app_admin"
}

export function canSendPushNotifications(role: user_role): boolean {
  return role === "app_admin"
}

/* -------------------------------------------------------------------------- */
/* Per-event permissions                                                       */
/* -------------------------------------------------------------------------- */

export interface PermissionActor {
  id: string
  role: user_role
}

/**
 * The two axes that decide access. `venue` is null when the event has no linked
 * venue, which is the common case — most events happen at places that are not
 * on the platform and carry only a free-text location.
 */
export interface PermissionEvent {
  organizer_id: string
  venue: { owner_id: string | null } | null
}

export interface EventPermissions {
  /** Edit, publish, cancel. The event is yours to change. */
  canEdit: boolean
  /**
   * Chat, moderation, the attendee list. What happens in your building.
   *
   * Deliberately one flag rather than three. The model defines the operational
   * bucket as a single thing — "the chatroom, moderation, who is walking in" —
   * and three fields that are always equal are noise, not flexibility. Split it
   * when a policy actually distinguishes them.
   */
  canOperate: boolean
}

const DENIED: EventPermissions = { canEdit: false, canOperate: false }

/**
 * Resolve what an actor may do with one event.
 *
 * Authorization used to be role-shaped and self-contradictory: `canManageEvent`
 * denied `venue_owner` unconditionally — so a venue owner could not manage even
 * their own event — while `canModerateChat` allowed them. A venue owner could
 * open the Chatrooms list and get bounced out of every room in it.
 *
 * It is now relationship-shaped. Two axes:
 *
 *     event.organizer_id     who RUNS it
 *     event.venue.owner_id   whose building it is IN
 *
 * and two buckets:
 *
 *     | actor       | condition                 | edit | operate |
 *     | app_admin   | always                    | yes  | yes     |
 *     | organiser   | event.organizer_id = me   | yes  | yes     |
 *     | venue owner | event.venue.owner_id = me | no   | yes     |
 *     | venue owner | event.organizer_id = me   | yes  | yes     |
 *
 * The venue-owner row is the point: you control what happens in your room —
 * chat, moderation, the guest list — but the event is not yours to change.
 * Host it yourself and you are the organiser, so you get both.
 *
 * Pinned by __tests__/event-permissions.test.ts, which asserts every row.
 */
export function eventPermissions(
  actor: PermissionActor,
  event: PermissionEvent
): EventPermissions {
  // Fails closed on a half-built actor. Without this an empty id could match an
  // unclaimed venue's null owner in the comparison further down.
  if (!actor?.id) return DENIED

  if (actor.role === "app_admin") return { canEdit: true, canOperate: true }

  if (actor.role !== "organizer" && actor.role !== "venue_owner") return DENIED

  // Whoever runs it gets both, whichever host role they hold.
  if (event.organizer_id === actor.id) return { canEdit: true, canOperate: true }

  // Operational only, and only for a venue that is actually claimed by them.
  const ownsVenue =
    actor.role === "venue_owner" &&
    event.venue?.owner_id != null &&
    event.venue.owner_id === actor.id

  return ownsVenue ? { canEdit: false, canOperate: true } : DENIED
}

/**
 * `select` fragment for loading an event with everything `eventPermissions`
 * needs. Exported so the ~17 call sites cannot drift into fetching a shape the
 * resolver silently reads as "no linked venue".
 */
export const eventPermissionSelect = {
  organizer_id: true,
  venue: { select: { owner_id: true } },
} as const
