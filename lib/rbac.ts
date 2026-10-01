import type { event_kind, user_role } from "@prisma/client"

export function canAccessDashboard(role: user_role): boolean {
  return (
    role === "app_admin" ||
    role === "organizer" ||
    role === "venue_owner" ||
    role === "sponsor"
  )
}

/**
 * The error a dashboard sign-in reports when the password is right and
 * `canAccessDashboard` says no. NextAuth hands a thrown message to the form as
 * `result.error`; the login page turns this one into a sentence (SCRUM-172).
 */
export const APP_ONLY_SIGNIN = "AppOnlyAccount"

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
  /**
   * Required, so a caller that forgot it does not typecheck: read as an
   * ordinary event, a venue day hands its owning org the people in the room
   * (F1). `eventPermissionSelect` carries it.
   */
  kind: event_kind
  organizer_org_id: string | null
  /**
   * Required, like `venue.claimed_at`, so a caller that forgot to select them
   * does not typecheck — rather than silently granting a venue owner the past.
   */
  start_time: Date
  venue: { owner_org_id: string | null; claimed_at: Date | null } | null
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
  /**
   * The Attendees view: labels for whoever runs the event, a held-back count
   * for the venue it is held at (`lib/attendee-roster.ts`).
   *
   * Split from `canOperate` for venue days only (F1, D-1). A venue day's
   * owner moderates its room and never learns who was in it — not as labels,
   * not as a count — because "who keeps coming to my place" is the regulars
   * list the venue is never given (plan v2 §2). Everywhere else it equals
   * `canOperate`.
   */
  canViewAttendees: boolean
}

const DENIED: EventPermissions = { canEdit: false, canOperate: false, canViewAttendees: false }
const ALL: EventPermissions = { canEdit: true, canOperate: true, canViewAttendees: true }

/**
 * Resolve what an actor may do with one event.
 *
 * Authorization is organisation-shaped. Two axes:
 *
 *     event.organizer_org_id     which company RUNS it
 *     event.venue.owner_org_id   whose building it is IN
 *
 *     | actor       | condition                          | edit | operate | attendees |
 *     | app_admin   | always                             | yes  | yes     | yes       |
 *     | host        | member of the organising org       | yes  | yes     | yes       |
 *     | venue owner | member of the venue's owning org   | no   | yes     | yes       |
 *
 *   and on a venue day (`kind = 'venue_day'`), whatever `organizer_org_id` says:
 *
 *     | app_admin   | always                             | yes  | yes     | yes       |
 *     | venue owner | member of the venue's owning org   | no   | yes     | no        |
 *     | anyone else |                                    | no   | no      | no        |
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

  if (actor.role === "app_admin") return ALL
  if (actor.role !== "organizer" && actor.role !== "venue_owner") return DENIED

  // Empty ids are filtered so a blank membership cannot match a null owner —
  // the null-equals-null hole, in its organisation form.
  const orgs = new Set((actor.orgIds ?? []).filter(Boolean))
  if (orgs.size === 0) return DENIED

  /*
   * A venue day is decided before the organiser branch, on purpose (F1).
   *
   * Its `organizer_org_id` is the venue's owning org once claimed, and the
   * branch below would hand that org edit, the room and the roster — the
   * regulars by label, night after night. Nobody runs a venue day: the owner
   * may moderate what is said in their building (D-1) and never see who said
   * it; an organiser, even of an event at the same venue that night, gets
   * nothing; the person whose Go Live created it is just an attendee.
   */
  if (event.kind === "venue_day") {
    return ownsVenueAt(actor, orgs, event) ? { canEdit: false, canOperate: true, canViewAttendees: false } : DENIED
  }

  // Whichever org runs it gets both, whatever host role its members hold.
  if (event.organizer_org_id && orgs.has(event.organizer_org_id)) return ALL

  /*
   * A claim opens what happens at the venue from then on — never its past
   * (owner's ruling 1, SCRUM-355). Operating an event is its chat, moderation
   * and attendee list, and nobody at an earlier event agreed to the venue's
   * new owner seeing them. That history is for aggregate insights (SCRUM-356).
   * No claim date on an owned venue is bad data: closed, not open.
   */
  return ownsVenueAt(actor, orgs, event) ? { canEdit: false, canOperate: true, canViewAttendees: true } : DENIED
}

function ownsVenueAt(actor: PermissionActor, orgs: Set<string>, event: PermissionEvent): boolean {
  return (
    actor.role === "venue_owner" &&
    event.venue?.owner_org_id != null &&
    orgs.has(event.venue.owner_org_id) &&
    event.venue.claimed_at != null &&
    event.start_time >= event.venue.claimed_at
  )
}

/**
 * `select` fragment for loading an event with everything the resolver needs.
 * Exported so call sites cannot drift into fetching a shape it silently reads
 * as "no organiser, no venue".
 */
export const eventPermissionSelect = {
  kind: true,
  organizer_org_id: true,
  start_time: true,
  venue: { select: { owner_org_id: true, claimed_at: true } },
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
 * Separate from `eventPermissions` because the three kinds do not share one
 * answer:
 *
 *     | kind         | who                                                  |
 *     | announcement | canEdit — whoever runs the event, not the venue      |
 *     | sponsored    | one org holding the flag AND a placement here        |
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
/**
 * The single organisation acting, and what it is entitled to.
 *
 * ## Why this is a tuple and not two booleans
 *
 * It was two booleans, and that was a confused deputy.
 * `lib/org-membership.ts:maySponsorFor` answers "does **any** org you belong to
 * hold the flag", and a `placesAtEvent` written the same way answers "does
 * **any** org you belong to have a placement". A person who is staff at Org A
 * (holds `may_sponsor`, no placement) and Org B (has a placement, no flag)
 * satisfies both, and posts a sponsored message that neither organisation is
 * entitled to send.
 *
 * Both facts must come from the SAME `org_id`. Resolving them together, once,
 * in `lib/org-membership.ts` is what makes that structural rather than a thing
 * every caller has to remember.
 *
 * Passed in rather than read here for the same reason `orgIds` is: this module
 * is reachable from `lib/validations/profile.ts`, which a client component may
 * import, and `__tests__/server-import-boundary.test.ts` exists because a `db`
 * import here has gone wrong before.
 */
export interface SponsorGrant {
  orgId: string
  /** `organisations.may_sponsor` for THIS org. */
  maySponsor: boolean
  /** THIS org holds an `approved` placement at THIS event. */
  placesAtEvent: boolean
}

export function canBroadcast(
  actor: PermissionActor,
  event: PermissionEvent,
  kind: BroadcastKind,
  /**
   * Omitted means no grant, which fails closed — the property
   * `__tests__/broadcast-permissions.test.ts` pins.
   */
  grant?: SponsorGrant
): boolean {
  if (!actor?.id) return false

  // Speaks as the platform. Nobody outside it, whatever they own.
  if (kind === "system") return actor.role === "app_admin"

  if (kind === "sponsored") {
    /*
     * app_admin is not exempt from the flag by accident — it is exempt on
     * purpose. An admin placing an ad is the platform placing an ad, which is
     * what `may_sponsor` is a delegation *of*.
     */
    if (actor.role === "app_admin") return true
    if (!grant) return false

    /*
     * Every sponsored message anchors to a placement, INCLUDING a host
     * promoting their own brand.
     *
     * An earlier draft allowed `canOperate && maySponsor` with no placement,
     * which contradicted the claim that the placement is the authorization
     * object — and left the sponsor's own org unable to post at all, since a
     * sponsor is neither the organising org nor the venue's owner and so never
     * has `canOperate`.
     */
    if (!grant.maySponsor || !grant.placesAtEvent) return false
    return true
  }

  /*
   * announcement: whoever runs the event — `canEdit`, not `canOperate`. A venue
   * owner operates what happens in their building but does not speak for an
   * event they do not run (R37), and `broadcastAuthorName` signs every
   * announcement with the organising org's name. This said `canOperate` after
   * R37 took the composer away, so `createPoll` still let a venue owner post
   * under the organiser's name (SCRUM-335).
   */
  return eventPermissions(actor, event).canEdit
}

/**
 * Who may create events.
 *
 * NOT "everyone who is not an attendee". `app/dashboard/events/new/page.tsx`
 * used to gate on `role === "attendee"`, a denylist — so adding `sponsor` to
 * the enum would have handed every sponsor the ability to publish events, with
 * no error and nothing in a log.
 */
export function canCreateEvents(role: user_role): boolean {
  return role === "app_admin" || role === "organizer" || role === "venue_owner"
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
