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

/* -------------------------------------------------------------------------- */
/* Broadcasting into an event's room                                           */
/* -------------------------------------------------------------------------- */

/**
 * The three message kinds that are not a person talking.
 *
 * They exist in `message_type` alongside `text`/`image`/`video`, and until now
 * only `announcement` had a writer at all — `sponsored` and `system` were
 * declared and unreachable.
 */
export type BroadcastKind = "announcement" | "sponsored" | "system"

/**
 * Who may put a non-user message into an event's room.
 *
 * Separate from `eventPermissions` rather than folded into `canOperate`,
 * because the three kinds do not share one answer and `canOperate` is
 * deliberately one flag:
 *
 *     | kind         | who                                                  |
 *     | announcement | anyone with canOperate — the host, or the venue      |
 *     | sponsored    | canOperate AND an org allowed to sell placement      |
 *     | system       | app_admin only — it speaks as Blend'n                |
 *
 * ## Why `sponsored` needs its own gate
 *
 * "Sponsored" is a claim that somebody *paid*. If everyone who can announce can
 * also mark a message sponsored, the label stops meaning anything and becomes a
 * styling choice — an organiser could dress an advertisement as an announcement
 * or the reverse, and a reader has no way to tell which they are looking at.
 * The word is only worth having if it is scarce.
 *
 * `maySponsor` comes from `organisations.may_sponsor`, granted by an admin. It
 * is deliberately an organisation-level flag rather than a role: the permission
 * belongs to the company with the commercial agreement, not to whichever of its
 * staff happens to be logged in.
 *
 * ## Why `system` is admin-only
 *
 * It renders as Blend'n itself. An organiser who could send one could issue a
 * safety notice, or a "verified by Blend'n" claim, in the platform's voice.
 */
export function canBroadcast(
  actor: PermissionActor,
  event: PermissionEvent,
  kind: BroadcastKind,
  /**
   * Whether any org this actor belongs to may sell placement.
   *
   * Passed in rather than read here for the same reason `orgIds` is: this
   * module is reachable from `lib/validations/profile.ts`, which a client
   * component may import, and `__tests__/server-import-boundary.test.ts` exists
   * because a `db` import here has gone wrong before.
   */
  maySponsor = false
): boolean {
  if (!actor?.id) return false

  // Speaks as the platform. Nobody outside it, whatever they own.
  if (kind === "system") return actor.role === "app_admin"

  const { canOperate } = eventPermissions(actor, event)
  if (!canOperate) return false

  /*
   * app_admin is not exempt from the flag by accident — it is exempt on
   * purpose. `eventPermissions` already returns true for them unconditionally,
   * and an admin placing an ad is the platform placing an ad, which is what
   * `may_sponsor` is a delegation *of*.
   */
  if (kind === "sponsored") return actor.role === "app_admin" || maySponsor

  return true
}

/**
 * Whether a broadcast of this kind may carry an image or a video.
 *
 * **Only `sponsored`**, and this is a safety rule rather than a product one.
 *
 * The event room is pseudonymous. A photograph is an identity — it deanonymises
 * whoever is in it, and the person in it is not always the person posting.
 * Attendee media is therefore not built at all, and an announcement is written
 * by a host who is *also* addressing that room, so it inherits the same rule.
 *
 * A sponsored message is different in kind: it is placement bought by a
 * company, its media is artwork rather than a person, and it is reviewed before
 * it runs. Nobody in the room is depicted by it.
 */
export function broadcastMayCarryMedia(kind: BroadcastKind): boolean {
  return kind === "sponsored"
}
