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
  /**
   * Organisations this actor is a member of. Empty denies everything.
   *
   * **Required, not optional.** It was optional, and that let
   * `eventPermissions(session.user, event)` typecheck — a NextAuth session user
   * has no `orgIds`, so the resolver read `undefined`, took the empty-set
   * branch, and denied every non-admin. The feedback screen shipped broken for
   * every organiser and venue owner and looked like an empty state.
   *
   * Making it required means the only way to build an actor is `actorFor()`,
   * which loads memberships. The compiler now catches what a test could not.
   */
  orgIds: string[]
}

/**
 * The two axes that decide access, now expressed as organisations.
 *
 * `venue` is null when the event has no linked venue, which remains the common
 * case — most events are at places not on the platform.
 */
export interface PermissionEvent {
  organizer_org_id: string | null
  venue: { owner_org_id: string | null } | null
}

export interface EventPermissions {
  /** Edit, publish, cancel. The event is yours to change. */
  canEdit: boolean
  /**
   * Chat, moderation, the attendee list. What happens in your building.
   *
   * One flag, not three: the model defines the operational bucket as a single
   * thing, and three fields that are always equal are noise.
   */
  canOperate: boolean
}

const DENIED: EventPermissions = { canEdit: false, canOperate: false }

/**
 * Resolve what an actor may do with one event.
 *
 * Authorization is organisation-shaped. Two axes:
 *
 *     event.organizer_org_id     which company RUNS it
 *     event.venue.owner_org_id   whose building it is IN
 *
 *     | actor       | condition                          | edit | operate |
 *     | app_admin   | always                             | yes  | yes     |
 *     | host        | member of the organising org       | yes  | yes     |
 *     | venue owner | member of the venue's owning org   | no   | yes     |
 *
 * Membership rather than identity is the point: a colleague who did not create
 * the event gets the same access, and the venue survives one person leaving.
 * `events.organizer_id` still records *who created it*, which is a different
 * question and stays useful for audit.
 *
 * Pinned by __tests__/event-permissions.test.ts, which asserts every row.
 */
export function eventPermissions(
  actor: PermissionActor,
  event: PermissionEvent
): EventPermissions {
  // Fails closed on a half-built actor.
  if (!actor?.id) return DENIED

  if (actor.role === "app_admin") return { canEdit: true, canOperate: true }
  if (actor.role !== "organizer" && actor.role !== "venue_owner") return DENIED

  // Empty ids are filtered so a blank membership cannot match a null owner —
  // the null-equals-null hole, in its organisation form.
  const orgs = new Set((actor.orgIds ?? []).filter(Boolean))
  if (orgs.size === 0) return DENIED

  // Whichever org runs it gets both, whatever host role its members hold.
  if (event.organizer_org_id && orgs.has(event.organizer_org_id)) {
    return { canEdit: true, canOperate: true }
  }

  const ownsVenue =
    actor.role === "venue_owner" &&
    event.venue?.owner_org_id != null &&
    orgs.has(event.venue.owner_org_id)

  return ownsVenue ? { canEdit: false, canOperate: true } : DENIED
}

/**
 * `select` fragment for loading an event with everything the resolver needs.
 * Exported so call sites cannot drift into fetching a shape it silently reads
 * as "no organiser, no venue".
 */
export const eventPermissionSelect = {
  organizer_org_id: true,
  venue: { select: { owner_org_id: true } },
} as const
