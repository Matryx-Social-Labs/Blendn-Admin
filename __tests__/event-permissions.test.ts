import { eventPermissions, type PermissionActor, type PermissionEvent } from "@/lib/rbac"

/**
 * The permission matrix. Written before the resolver, for the third time.
 *
 * Authorization has now moved twice. It began role-shaped and
 * self-contradictory (`canManageEvent` denied venue owners while
 * `canModerateChat` allowed them). It became relationship-shaped, resolving on
 * `organizer_id` and `venue.owner_id` being *user* ids. It now resolves on
 * **organisation membership**, because a host is a company rather than a login:
 * Byg Brewski's staff need access, and the venue must survive one person
 * leaving.
 *
 * The shape of a mistake here is an access-control bug, not a broken screen, so
 * every row is asserted and the new rows are written first.
 *
 * `kind: individual` is what lets a sole-trader organiser exist without a
 * company: they get an org of one member and no GSTIN. Everything is an org, so
 * no call site needs a user-or-org union.
 */

const ADMIN = "usr_admin"
const ALICE = "usr_alice" // owner of ORG_HOST
const BOB = "usr_bob" // staff at ORG_HOST
const CARA = "usr_cara" // owner of ORG_VENUE
const STRANGER = "usr_stranger" // member of nothing relevant

const ORG_HOST = "org_host"
const ORG_VENUE = "org_venue"
const ORG_OTHER = "org_other"

/** An actor carries the orgs they belong to — the resolver stays pure. */
const actor = (
  id: string,
  role: PermissionActor["role"],
  orgIds: string[] = []
): PermissionActor => ({ id, role, orgIds })

const event = (organizerOrgId: string, venueOwnerOrgId?: string | null): PermissionEvent => ({
  organizer_org_id: organizerOrgId,
  venue: venueOwnerOrgId === undefined ? null : { owner_org_id: venueOwnerOrgId },
})

describe("eventPermissions — the matrix", () => {
  it("gives app_admin everything, on any event", () => {
    const p = eventPermissions(actor(ADMIN, "app_admin"), event(ORG_HOST, ORG_VENUE))
    expect(p.canEdit).toBe(true)
    expect(p.canOperate).toBe(true)
  })

  it("gives a member of the organising org both buckets", () => {
    const p = eventPermissions(actor(ALICE, "organizer", [ORG_HOST]), event(ORG_HOST))
    expect(p.canEdit).toBe(true)
    expect(p.canOperate).toBe(true)
  })

  it("gives a COLLEAGUE the same access as the person who created it", () => {
    // The whole point of modelling the company. Bob did not create this event
    // and is not named on it anywhere — he simply works there.
    const p = eventPermissions(actor(BOB, "organizer", [ORG_HOST]), event(ORG_HOST))
    expect(p.canEdit).toBe(true)
    expect(p.canOperate).toBe(true)
  })

  it("gives a member of a different org nothing", () => {
    const p = eventPermissions(actor(STRANGER, "organizer", [ORG_OTHER]), event(ORG_HOST))
    expect(p.canEdit).toBe(false)
    expect(p.canOperate).toBe(false)
  })

  it("gives the venue's org operational control and no editorial", () => {
    const p = eventPermissions(
      actor(CARA, "venue_owner", [ORG_VENUE]),
      event(ORG_HOST, ORG_VENUE)
    )
    expect(p.canOperate).toBe(true)
    expect(p.canEdit).toBe(false)
  })

  it("gives both buckets when the venue's org also runs the event", () => {
    const p = eventPermissions(
      actor(CARA, "venue_owner", [ORG_VENUE]),
      event(ORG_VENUE, ORG_VENUE)
    )
    expect(p.canEdit).toBe(true)
    expect(p.canOperate).toBe(true)
  })

  it("gives a venue owner nothing on an event neither theirs nor at their venue", () => {
    const p = eventPermissions(
      actor(CARA, "venue_owner", [ORG_VENUE]),
      event(ORG_HOST, ORG_OTHER)
    )
    expect(p.canEdit).toBe(false)
    expect(p.canOperate).toBe(false)
  })

  it("gives an attendee nothing, ever", () => {
    for (const ev of [event(ORG_HOST), event(ORG_HOST, ORG_VENUE)]) {
      expect(eventPermissions(actor(STRANGER, "attendee", [ORG_HOST]), ev).canOperate).toBe(false)
    }
  })
})

describe("eventPermissions — multi-org membership", () => {
  it("resolves on any org the actor belongs to, not just the first", () => {
    // An agency running events for several clients is a real shape; matching
    // only orgIds[0] would deny them everything but one.
    const p = eventPermissions(
      actor(ALICE, "organizer", [ORG_OTHER, ORG_HOST]),
      event(ORG_HOST)
    )
    expect(p.canEdit).toBe(true)
  })
})

describe("eventPermissions — the unlinked venue, still the common case", () => {
  it("grants no venue rights when the event has no linked venue", () => {
    const p = eventPermissions(actor(CARA, "venue_owner", [ORG_VENUE]), event(ORG_HOST, undefined))
    expect(p.canOperate).toBe(false)
  })

  it("grants no venue rights when the venue is unclaimed", () => {
    const p = eventPermissions(actor(CARA, "venue_owner", [ORG_VENUE]), event(ORG_HOST, null))
    expect(p.canOperate).toBe(false)
  })
})

describe("eventPermissions — fails closed", () => {
  it("denies an actor with no org memberships", () => {
    // A newly created host account before it is attached to anything.
    const p = eventPermissions(actor(ALICE, "organizer", []), event(ORG_HOST))
    expect(p.canEdit).toBe(false)
    expect(p.canOperate).toBe(false)
  })

  it("denies when the actor id is empty", () => {
    expect(eventPermissions(actor("", "organizer", [ORG_HOST]), event(ORG_HOST)).canEdit).toBe(
      false
    )
  })

  it("never matches an empty org id against a null venue owner", () => {
    // The null-equals-null hole, in its new form.
    const p = eventPermissions(actor(CARA, "venue_owner", [""]), event(ORG_HOST, null))
    expect(p.canOperate).toBe(false)
  })

  it("denies an unknown role outright", () => {
    const p = eventPermissions(
      actor(ALICE, "unknown_role" as PermissionActor["role"], [ORG_HOST]),
      event(ORG_HOST)
    )
    expect(p.canEdit).toBe(false)
    expect(p.canOperate).toBe(false)
  })
})

describe("eventPermissions — editorial always implies operational", () => {
  it("never grants edit without operate", () => {
    const actors: PermissionActor[] = [
      actor(ADMIN, "app_admin"),
      actor(ALICE, "organizer", [ORG_HOST]),
      actor(CARA, "venue_owner", [ORG_VENUE]),
      actor(STRANGER, "organizer", [ORG_OTHER]),
      actor(STRANGER, "attendee", []),
    ]
    const events = [
      event(ORG_HOST),
      event(ORG_HOST, ORG_VENUE),
      event(ORG_VENUE, ORG_VENUE),
      event(ORG_HOST, null),
    ]
    for (const a of actors) {
      for (const e of events) {
        const p = eventPermissions(a, e)
        if (p.canEdit) expect(p.canOperate).toBe(true)
      }
    }
  })
})
