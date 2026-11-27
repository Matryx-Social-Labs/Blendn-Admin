import { eventPermissions, operatesThroughVenue, type PermissionActor, type PermissionEvent } from "@/lib/rbac"

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
const BOB = "usr_bob" // admin at ORG_HOST
const DEV = "usr_dev" // staff at ORG_HOST: the door volunteer
const CARA = "usr_cara" // owner of ORG_VENUE
const STRANGER = "usr_stranger" // member of nothing relevant

const ORG_HOST = "org_host"
const ORG_VENUE = "org_venue"
const ORG_OTHER = "org_other"

/**
 * An actor carries the orgs they belong to — the resolver stays pure. Owner or
 * admin of each unless `editOrgIds` says fewer; `staff` gives the rest.
 */
const actor = (
  id: string,
  role: PermissionActor["role"],
  orgIds: string[] = [],
  editOrgIds: string[] = orgIds
): PermissionActor => ({ id, role, orgIds, editOrgIds })
/** A `staff` member of these orgs: a member, owner or admin of none. */
const staff = (id: string, role: PermissionActor["role"], orgIds: string[]) => actor(id, role, orgIds, [])

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

  it("gives an org's staff member the room and the door, never edit or the roster (SCRUM-1244)", () => {
    // A door volunteer invited as staff cancelled nothing before this only by luck.
    const p = eventPermissions(staff(DEV, "organizer", [ORG_HOST]), event(ORG_HOST))
    expect(p).toEqual({ canEdit: false, canOperate: true, canViewAttendees: false })
  })

  it("keeps everything for the org's owner and admin", () => {
    expect(eventPermissions(actor(ALICE, "organizer", [ORG_HOST]), event(ORG_HOST))).toEqual({ canEdit: true, canOperate: true, canViewAttendees: true })
    expect(eventPermissions(actor(BOB, "organizer", [ORG_HOST]), event(ORG_HOST, ORG_VENUE))).toEqual({ canEdit: true, canOperate: true, canViewAttendees: true })
  })

  it("gives staff at one org and owner at another each org's own answer", () => {
    const both = actor(DEV, "organizer", [ORG_HOST, ORG_OTHER], [ORG_OTHER])
    expect(eventPermissions(both, event(ORG_HOST)).canEdit).toBe(false)
    expect(eventPermissions(both, event(ORG_OTHER)).canEdit).toBe(true)
  })

  it("reads an edit right only through membership: an editOrgIds entry outside orgIds grants nothing", () => {
    // `actorFor` builds both from one query, so this is a hand-built actor; it must fail closed.
    expect(eventPermissions(actor(DEV, "organizer", [ORG_OTHER], [ORG_HOST]), event(ORG_HOST))).toEqual({ canEdit: false, canOperate: false, canViewAttendees: false })
  })

  it("does not let a staff member's membership reach a venue day as the host: the venue's answer, never edit or the roster", () => {
    // Venue-org staff moderate the building's room like its owner (SCRUM-1246); the host branch never answers a venue day.
    expect(eventPermissions(staff(DEV, "organizer", [ORG_VENUE]), event(ORG_VENUE, ORG_VENUE, { kind: "venue_day" }))).toEqual({ canEdit: false, canOperate: true, canViewAttendees: false })
  })

  it("gives someone who is the host org's staff and owns the venue's org the union: operate and the count, never edit (SCRUM-1246)", () => {
    // Rights are the union of memberships: being host staff takes nothing from the venue.
    // `canEdit` stays false, so the Attendees view is the held-back count, never labels.
    const twoHats = actor(DEV, "venue_owner", [ORG_HOST, ORG_VENUE], [ORG_VENUE])
    expect(eventPermissions(twoHats, event(ORG_HOST, ORG_VENUE))).toEqual({ canEdit: false, canOperate: true, canViewAttendees: true })
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

  it("gives an attendee who is in no organisation nothing", () => {
    for (const ev of [event(ORG_HOST), event(ORG_HOST, ORG_VENUE)]) {
      expect(eventPermissions(actor(STRANGER, "attendee"), ev)).toEqual({ canEdit: false, canOperate: false, canViewAttendees: false })
    }
  })
})

/*
 * Rights come from the organisation, not the person's `User.role` (SCRUM-1246,
 * DECISIONS 2026-11-25: hosts keep the attendee app). `role` is read only for
 * `app_admin`; everything else is which orgs, in which org role, and the venue's
 * claim.
 */
describe("eventPermissions — organisation facts, whatever User.role says", () => {
  it("gives an attendee-role owner of the organising org what an organizer-role owner gets", () => {
    for (const ev of [event(ORG_HOST), event(ORG_HOST, ORG_VENUE)]) {
      expect(eventPermissions(actor(ALICE, "attendee", [ORG_HOST]), ev)).toEqual(eventPermissions(actor(ALICE, "organizer", [ORG_HOST]), ev))
      expect(eventPermissions(actor(ALICE, "attendee", [ORG_HOST]), ev)).toEqual({ canEdit: true, canOperate: true, canViewAttendees: true })
    }
  })

  it("gives an attendee-role staff member of the organising org what an organizer-role staff member gets", () => {
    expect(eventPermissions(staff(DEV, "attendee", [ORG_HOST]), event(ORG_HOST))).toEqual({ canEdit: false, canOperate: true, canViewAttendees: false })
  })

  it("gives a sponsor-role member of the organising org the same as an organizer-role one", () => {
    expect(eventPermissions(actor(ALICE, "sponsor", [ORG_HOST]), event(ORG_HOST))).toEqual({ canEdit: true, canOperate: true, canViewAttendees: true })
  })

  it("lets an organizer-role member of the venue-owning org operate an event there after the claim", () => {
    expect(eventPermissions(actor(ALICE, "organizer", [ORG_VENUE]), event(ORG_HOST, ORG_VENUE))).toEqual({ canEdit: false, canOperate: true, canViewAttendees: true })
  })

  it("still closes the venue's past to that member: before the claim is nothing", () => {
    const before = event(ORG_HOST, ORG_VENUE, { startsAt: new Date(CLAIMED.getTime() - DAY) })
    expect(eventPermissions(actor(ALICE, "organizer", [ORG_VENUE]), before)).toEqual({ canEdit: false, canOperate: false, canViewAttendees: false })
  })

  it("keeps the held-back count for the venue-owning org's staff, as the venue page already shows them", () => {
    expect(eventPermissions(staff(DEV, "organizer", [ORG_VENUE]), event(ORG_HOST, ORG_VENUE))).toEqual({ canEdit: false, canOperate: true, canViewAttendees: true })
  })

  it("keeps an organizer-role owner/admin's rights exactly as before (the pilot hosts)", () => {
    // Every event shape an organiser's org meets, for an owner and an admin of it.
    const shapes = [
      event(ORG_HOST),
      event(ORG_HOST, ORG_VENUE),
      event(ORG_HOST, null),
      event(ORG_HOST, ORG_VENUE, { startsAt: new Date(CLAIMED.getTime() - DAY) }),
      event(ORG_OTHER),
      event(ORG_OTHER, ORG_VENUE),
    ]
    const ALL = { canEdit: true, canOperate: true, canViewAttendees: true }
    const NONE = { canEdit: false, canOperate: false, canViewAttendees: false }
    for (const who of [ALICE, BOB]) {
      expect(shapes.map((e) => eventPermissions(actor(who, "organizer", [ORG_HOST]), e))).toEqual([ALL, ALL, ALL, ALL, NONE, NONE])
    }
  })
})

/*
 * A venue day (F1, D-1). Its `organizer_org_id` is null by CHECK; these rows
 * also feed it one, because if it ever had one the organiser branch would hand
 * that org everything, and the venue-day branch must answer first.
 */
describe("eventPermissions — a venue day", () => {
  const day = (organizerOrgId: string | null, opts: { startsAt?: Date; claimedAt?: Date | null } = {}) =>
    event(organizerOrgId as string, ORG_VENUE, { ...opts, kind: "venue_day" })

  it("lets the venue's owner moderate the room and never see who is in it", () => {
    const p = eventPermissions(actor(CARA, "venue_owner", [ORG_VENUE]), day(ORG_VENUE))
    expect(p).toEqual({ canEdit: false, canOperate: true, canViewAttendees: false })
  })

  it("does not read organizer_org_id: a member of the day's org gets the venue's answer, never the host's", () => {
    // A member of the venue's org matches organizer_org_id and would take the
    // host branch — edit and the roster — on an ordinary event. Whatever their
    // User.role, they get what the venue's owner gets (SCRUM-1246).
    const p = eventPermissions(actor(ALICE, "organizer", [ORG_VENUE]), day(ORG_VENUE))
    expect(p).toEqual({ canEdit: false, canOperate: true, canViewAttendees: false })
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

  it("answers to the venue's owner today, not the org written on the day", () => {
    // A venue that changed hands: yesterday's day still names the old org.
    const transferred = event(ORG_OTHER, ORG_VENUE, { kind: "venue_day" })
    expect(eventPermissions(actor(CARA, "venue_owner", [ORG_VENUE]), transferred).canOperate).toBe(true)
    expect(eventPermissions(actor("usr_old", "venue_owner", [ORG_OTHER]), transferred).canOperate).toBe(false)
  })

  it("fails closed on a row that reached the resolver without its kind", () => {
    const noKind = { ...day(ORG_VENUE), kind: undefined } as unknown as PermissionEvent
    expect(eventPermissions(actor(CARA, "venue_owner", [ORG_VENUE]), noKind).canViewAttendees).toBe(false)
    expect(eventPermissions(actor(ALICE, "organizer", [ORG_VENUE]), noKind).canEdit).toBe(false)
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

  it("denies any role with no memberships: the role grants nothing but app_admin", () => {
    for (const role of ["organizer", "venue_owner", "sponsor", "attendee", "unknown_role"] as PermissionActor["role"][]) {
      expect(eventPermissions(actor(ALICE, role, []), event(ORG_HOST, ORG_VENUE))).toEqual({ canEdit: false, canOperate: false, canViewAttendees: false })
    }
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


describe("operatesThroughVenue — whose relationship the access comes from (SCRUM-1446)", () => {
  // The Overview tells a non-editing viewer why: the venue sentence only when
  // the resolver's answer is the venue's row; org staff are told their team.
  it("is true for a venue member on an event from the claim on", () => {
    expect(operatesThroughVenue(actor(CARA, "venue_owner", [ORG_VENUE]), event(ORG_HOST, ORG_VENUE))).toBe(true)
  })

  it("is false for staff of the organizing org: their access is the team's, not the building's", () => {
    expect(operatesThroughVenue(staff(DEV, "organizer", [ORG_HOST]), event(ORG_HOST, ORG_VENUE))).toBe(false)
  })

  it("is true for staff who are also in the venue's org, as the resolver's first matching row says", () => {
    expect(operatesThroughVenue(actor(DEV, "organizer", [ORG_HOST, ORG_VENUE], [ORG_VENUE]), event(ORG_HOST, ORG_VENUE))).toBe(true)
  })

  it("is false for whoever may edit, even when they are also in the venue's org", () => {
    expect(operatesThroughVenue(actor(ALICE, "organizer", [ORG_HOST, ORG_VENUE]), event(ORG_HOST, ORG_VENUE))).toBe(false)
    expect(operatesThroughVenue(actor(ADMIN, "app_admin"), event(ORG_HOST, ORG_VENUE))).toBe(false)
  })

  it("is true for the venue's member on its venue day", () => {
    expect(operatesThroughVenue(actor(CARA, "venue_owner", [ORG_VENUE]), event(ORG_VENUE, ORG_VENUE, { kind: "venue_day" }))).toBe(true)
  })

  it("is false for anyone who may not operate it: an event before the claim, a stranger", () => {
    const beforeClaim = event(ORG_HOST, ORG_VENUE, { startsAt: new Date(Date.now() - 400 * DAY) })
    expect(operatesThroughVenue(actor(CARA, "venue_owner", [ORG_VENUE]), beforeClaim)).toBe(false)
    expect(operatesThroughVenue(actor(STRANGER, "organizer", [ORG_OTHER]), event(ORG_HOST, ORG_VENUE))).toBe(false)
  })
})
