import { eventPermissions, type PermissionActor, type PermissionEvent } from "@/lib/rbac"

/**
 * The permission matrix, written before the resolver.
 *
 * Authorization used to be role-shaped: `canManageEvent` returned false for
 * `venue_owner` unconditionally, while `canModerateChat` said venue owners
 * could moderate. The two disagreed, and a venue owner could reach the
 * Chatrooms list but got bounced out of every room in it.
 *
 * It is now relationship-shaped. Two independent axes on an event —
 * `organizer_id` (who runs it) and `venue.owner_id` (whose building it is in) —
 * and two buckets of control:
 *
 *   editorial   edit, publish, cancel      the event is yours to change
 *   operational chat, moderation, attendees  what happens in your building
 *
 * Every row of the decided model is asserted here. If a row is wrong the
 * resolver is wrong, not this file.
 */

const ADMIN = "usr_admin"
const ORGANISER = "usr_organiser"
const VENUE_OWNER = "usr_venue_owner"
const STRANGER = "usr_stranger"

const actor = (id: string, role: PermissionActor["role"]): PermissionActor => ({ id, role })

const event = (organizerId: string, venueOwnerId?: string | null): PermissionEvent => ({
  organizer_id: organizerId,
  venue: venueOwnerId === undefined ? null : { owner_id: venueOwnerId },
})

describe("eventPermissions — the decided matrix", () => {
  it("gives app_admin everything, on any event", () => {
    const p = eventPermissions(actor(ADMIN, "app_admin"), event(ORGANISER, VENUE_OWNER))
    expect(p.canEdit).toBe(true)
    expect(p.canOperate).toBe(true)
  })

  it("gives the organiser of an event both buckets", () => {
    const p = eventPermissions(actor(ORGANISER, "organizer"), event(ORGANISER))
    expect(p.canEdit).toBe(true)
    expect(p.canOperate).toBe(true)
  })

  it("gives an organiser nothing on someone else's event", () => {
    const p = eventPermissions(actor(STRANGER, "organizer"), event(ORGANISER))
    expect(p.canEdit).toBe(false)
    expect(p.canOperate).toBe(false)
  })

  it("gives a venue owner operational control of an event in their building, and no editorial", () => {
    // The row that did not exist before. Someone else runs the event; it is
    // happening in your venue, so you get the chatroom, moderation and the
    // guest list — but the event is not yours to change.
    const p = eventPermissions(
      actor(VENUE_OWNER, "venue_owner"),
      event(ORGANISER, VENUE_OWNER)
    )
    expect(p.canOperate).toBe(true)
    expect(p.canEdit).toBe(false)
  })

  it("gives a venue owner both buckets on an event they run themselves", () => {
    // Hosting your own event makes you the organiser. The old resolver denied
    // this outright, so a venue owner could not manage even their own event.
    const p = eventPermissions(
      actor(VENUE_OWNER, "venue_owner"),
      event(VENUE_OWNER, VENUE_OWNER)
    )
    expect(p.canEdit).toBe(true)
    expect(p.canOperate).toBe(true)
  })

  it("gives a venue owner nothing on an event that is neither theirs nor at their venue", () => {
    const p = eventPermissions(
      actor(VENUE_OWNER, "venue_owner"),
      event(ORGANISER, STRANGER)
    )
    expect(p.canEdit).toBe(false)
    expect(p.canOperate).toBe(false)
  })

  it("gives an attendee nothing, ever", () => {
    for (const ev of [event(ORGANISER), event(ORGANISER, VENUE_OWNER)]) {
      const p = eventPermissions(actor(STRANGER, "attendee"), ev)
      expect(p.canEdit).toBe(false)
      expect(p.canOperate).toBe(false)
    }
  })
})

describe("eventPermissions — the unlinked-venue case, which is the common one", () => {
  it("grants no venue rights when the event has no linked venue", () => {
    // Most events are at places not on the platform: free-text location, no
    // venue record. Nobody gets venue-derived access, and nothing breaks.
    const p = eventPermissions(actor(VENUE_OWNER, "venue_owner"), event(ORGANISER, undefined))
    expect(p.canOperate).toBe(false)
    expect(p.canEdit).toBe(false)
  })

  it("grants no venue rights when the venue exists but is unclaimed", () => {
    // A venue record with no owner — created by an admin, never claimed.
    // `owner_id` is null and must not match a null-ish actor id.
    const p = eventPermissions(actor(VENUE_OWNER, "venue_owner"), event(ORGANISER, null))
    expect(p.canOperate).toBe(false)
    expect(p.canEdit).toBe(false)
  })
})

describe("eventPermissions — fails closed", () => {
  it("denies when the actor id is empty, even if the venue owner is also empty", () => {
    // Guards the classic null-equals-null hole: an unauthenticated or
    // half-built actor must never match an unclaimed venue.
    const p = eventPermissions(actor("", "venue_owner"), event(ORGANISER, null))
    expect(p.canOperate).toBe(false)
    expect(p.canEdit).toBe(false)
  })

  it("denies an unknown role outright", () => {
    const p = eventPermissions(
      actor(ORGANISER, "unknown_role" as PermissionActor["role"]),
      event(ORGANISER, ORGANISER)
    )
    expect(p.canEdit).toBe(false)
    expect(p.canOperate).toBe(false)
  })
})

describe("eventPermissions — editorial always implies operational", () => {
  it("never grants edit without operate", () => {
    // You cannot be allowed to cancel an event but not read its chatroom.
    // Asserted across the whole matrix so a future rule cannot invert it.
    const actors: PermissionActor[] = [
      actor(ADMIN, "app_admin"),
      actor(ORGANISER, "organizer"),
      actor(VENUE_OWNER, "venue_owner"),
      actor(STRANGER, "organizer"),
      actor(STRANGER, "attendee"),
    ]
    const events = [
      event(ORGANISER),
      event(ORGANISER, VENUE_OWNER),
      event(VENUE_OWNER, VENUE_OWNER),
      event(ORGANISER, null),
    ]
    for (const a of actors) {
      for (const e of events) {
        const p = eventPermissions(a, e)
        if (p.canEdit) expect(p.canOperate).toBe(true)
      }
    }
  })
})
