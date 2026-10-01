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

const DAY = 86_400_000
/** Claimed a year ago; the event is next week — a claim older than the event. */
const CLAIMED = new Date(Date.now() - 365 * DAY)
const event = (
  organizerOrgId: string,
  venueOwnerOrgId?: string | null,
  {
    startsAt = new Date(Date.now() + 7 * DAY),
    claimedAt = CLAIMED,
    kind = "event",
  }: { startsAt?: Date; claimedAt?: Date | null; kind?: PermissionEvent["kind"] } = {}
): PermissionEvent => ({
  kind,
  organizer_org_id: organizerOrgId,
  start_time: startsAt,
  venue: venueOwnerOrgId === undefined ? null : { owner_org_id: venueOwnerOrgId, claimed_at: claimedAt },
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

/*
 * A venue day (F1, D-1). Its `organizer_org_id` is the venue's owning org once
 * claimed, which is exactly the org the default branch would hand everything.
 */
describe("eventPermissions — a venue day", () => {
  const day = (organizerOrgId: string | null, opts: { startsAt?: Date; claimedAt?: Date | null } = {}) =>
    event(organizerOrgId as string, ORG_VENUE, { ...opts, kind: "venue_day" })

  it("lets the venue's owner moderate the room and never see who is in it", () => {
    const p = eventPermissions(actor(CARA, "venue_owner", [ORG_VENUE]), day(ORG_VENUE))
    expect(p).toEqual({ canEdit: false, canOperate: true, canViewAttendees: false })
  })

  it("does not read organizer_org_id: owning the day's org is not running it", () => {
    // An organiser-role member of the venue's org matches organizer_org_id and
    // would take the host branch — edit and the roster — on an ordinary event.
    const p = eventPermissions(actor(ALICE, "organizer", [ORG_VENUE]), day(ORG_VENUE))
    expect(p).toEqual({ canEdit: false, canOperate: false, canViewAttendees: false })
  })

  it("gives an organiser of another event at the venue nothing", () => {
    const p = eventPermissions(actor(BOB, "organizer", [ORG_HOST]), day(ORG_VENUE))
    expect(p).toEqual({ canEdit: false, canOperate: false, canViewAttendees: false })
  })

  it("gives the person whose Go Live created it nothing", () => {
    expect(eventPermissions(actor(STRANGER, "attendee"), day(null)).canOperate).toBe(false)
  })

  it("closes a day that began before the claim (PL-I14)", () => {
    const claimedAt = new Date(Date.now() - 2 * 3_600_000)
    const p = eventPermissions(
      actor(CARA, "venue_owner", [ORG_VENUE]),
      day(null, { startsAt: new Date(claimedAt.getTime() - 8 * 3_600_000), claimedAt })
    )
    expect(p.canOperate).toBe(false)
  })

  it("gives app_admin everything, so the platform can moderate unclaimed rooms", () => {
    expect(eventPermissions(actor(ADMIN, "app_admin"), day(null))).toEqual({
      canEdit: true,
      canOperate: true,
      canViewAttendees: true,
    })
  })

  it("keeps canViewAttendees equal to canOperate on ordinary events", () => {
    for (const [a, ev] of [
      [actor(CARA, "venue_owner", [ORG_VENUE]), event(ORG_HOST, ORG_VENUE)],
      [actor(ALICE, "organizer", [ORG_HOST]), event(ORG_HOST)],
      [actor(STRANGER, "organizer", [ORG_OTHER]), event(ORG_HOST)],
    ] as const) {
      const p = eventPermissions(a, ev)
      expect(p.canViewAttendees).toBe(p.canOperate)
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

describe("the actor must carry its memberships — the bug the compiler now blocks", () => {
  it("denies an actor built without orgIds", () => {
    // `eventPermissions(session.user, event)` used to typecheck, because
    // `orgIds` was optional and a NextAuth session user simply does not have
    // it. The resolver read `undefined`, took the empty-set branch, and denied
    // every non-admin — the feedback screen shipped broken for every organiser
    // and venue owner, and rendered as an ordinary empty state.
    //
    // `orgIds` is required now, so this cannot be written by accident. The cast
    // reproduces what used to compile.
    const sessionShaped = { id: ALICE, role: "organizer" } as unknown as PermissionActor
    expect(eventPermissions(sessionShaped, event(ORG_HOST)).canOperate).toBe(false)
  })

  it("grants the same actor once its memberships are loaded", () => {
    // The contrast that makes the bug legible: identical person, identical
    // event, and the only difference is whether actorFor() was called.
    expect(eventPermissions(actor(ALICE, "organizer", [ORG_HOST]), event(ORG_HOST)).canOperate).toBe(
      true
    )
  })
})

describe("eventPermissions — a claim does not open the venue's past (SCRUM-355, owner's ruling 1)", () => {
  /*
   * An approved claim made the owner an operator — chat, moderation, the
   * attendee list — of every event ever linked to the venue. With organisers
   * adding unclaimed venues (SCRUM-352), that history can be long and none of
   * it was agreed to. The owner's ruling: the past is for aggregate, paid
   * insights later (SCRUM-356), never operational access.
   */
  const owner = () => actor(CARA, "venue_owner", [ORG_VENUE])
  const claimedAt = new Date(Date.now() - 30 * DAY)

  it("denies the owner an event that started before the claim", () => {
    const before = event(ORG_HOST, ORG_VENUE, { startsAt: new Date(claimedAt.getTime() - DAY), claimedAt })
    expect(eventPermissions(owner(), before)).toEqual({ canEdit: false, canOperate: false, canViewAttendees: false })
  })

  it("lets the owner operate an event that starts after the claim", () => {
    const after = event(ORG_HOST, ORG_VENUE, { startsAt: new Date(claimedAt.getTime() + DAY), claimedAt })
    expect(eventPermissions(owner(), after)).toEqual({ canEdit: false, canOperate: true, canViewAttendees: true })
  })

  it("fails closed on an owned venue with no claim date — every writer sets one", () => {
    const unknown = event(ORG_HOST, ORG_VENUE, { claimedAt: null })
    expect(eventPermissions(owner(), unknown).canOperate).toBe(false)
  })

  it("leaves the organising organisation's access alone, before or after", () => {
    const before = event(ORG_HOST, ORG_VENUE, { startsAt: new Date(claimedAt.getTime() - DAY), claimedAt })
    expect(eventPermissions(actor(ALICE, "organizer", [ORG_HOST]), before)).toEqual({ canEdit: true, canOperate: true, canViewAttendees: true })
  })

  it("leaves an owner that also runs the event with both buckets", () => {
    const own = event(ORG_VENUE, ORG_VENUE, { startsAt: new Date(claimedAt.getTime() - DAY), claimedAt })
    expect(eventPermissions(owner(), own)).toEqual({ canEdit: true, canOperate: true, canViewAttendees: true })
  })
})

