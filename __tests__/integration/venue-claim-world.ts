import { cleanup, db, makeEvent, makeUser, testId } from "./helpers"

/**
 * One fixture world for the claim-window suites (SCRUM-500, SCRUM-501).
 *
 * A venue owner's org owns two venues claimed on different days, a host org
 * runs nights there either side of each claim, the owner's org hosts one of
 * its own (SCRUM-320), and the counts are chosen to sit on each side of every
 * disclosure rule: under the floor, at it, the whole RSVP list, all but one.
 *
 * Not a suite: `jest.integration.config.ts` only runs `*.itest.ts`.
 */

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

export interface Night {
  id: string
  /** Occurrence ids, one per day, in order. */
  days: string[]
  /** Guest (attendee) user ids, per day. */
  guests: string[][]
}

interface NightSpec {
  venue: string
  start: Date
  /** Defaults to the host org and host. */
  org?: string
  creator?: string
  /** Attendee check-ins per day (checked_in), one entry per day. */
  guests?: number[]
  /** Staff check-ins per day. */
  staff?: number[]
  /** Extra attendee rows on day one by status, for the predicate cases. */
  statuses?: Array<"checked_out" | "pending" | "cancelled">
  /** Going RSVPs. Defaults to 10, so a count is neither complete nor residual. */
  going?: number
  /** Override the first day's calendar date (event-local), as YYYY-MM-DD. */
  firstDay?: string
  hours?: number
}

export class VenueClaimWorld {
  readonly users: string[] = []
  readonly orgs: string[] = []
  readonly events: string[] = []
  readonly venues: string[] = []

  host = ""
  owner = ""
  /** A member of the venue's org whose ROLE is organiser: no venue arm. */
  colleague = ""
  hostOrg = ""
  venueOrg = ""
  otherOrg = ""
  v1 = ""
  v2 = ""
  otherVenue = ""
  readonly c1 = new Date(Date.now() - 4 * DAY)
  readonly c2 = new Date(Date.now() - 12 * DAY)

  async user(label: string, role: "attendee" | "organizer" = "attendee") {
    const id = await makeUser(label, role)
    this.users.push(id)
    return id
  }

  async org(label: string, ...members: string[]) {
    const o = await db.organisations.create({
      data: { kind: "company", display_name: testId(label), status: "verified" },
    })
    this.orgs.push(o.id)
    for (const user_id of members) {
      await db.organisation_members.create({ data: { org_id: o.id, user_id, role: "owner" } })
    }
    return o.id
  }

  async venue(label: string, ownerOrg: string | null, claimedAt: Date | null) {
    const v = await db.venues.create({
      data: { name: testId(label), latitude: 12.9, longitude: 77.5, owner_org_id: ownerOrg, claimed_at: claimedAt },
      select: { id: true },
    })
    this.venues.push(v.id)
    return v.id
  }

  async build() {
    this.host = await this.user("vcw-host", "organizer")
    this.owner = await this.user("vcw-owner", "organizer")
    this.colleague = await this.user("vcw-colleague", "organizer")
    await db.user.update({ where: { id: this.owner }, data: { role: "venue_owner" } })
    const stranger = await this.user("vcw-stranger", "organizer")

    this.hostOrg = await this.org("vcw-host-org", this.host)
    this.venueOrg = await this.org("vcw-venue-org", this.owner, this.colleague)
    this.otherOrg = await this.org("vcw-other-org", stranger)

    this.v1 = await this.venue("vcw-v1", this.venueOrg, this.c1)
    this.v2 = await this.venue("vcw-v2", this.venueOrg, this.c2)
    this.otherVenue = await this.venue("vcw-elsewhere", this.otherOrg, this.c2)
    return this
  }

  /** A night at a venue, with its check-ins and RSVPs. */
  async night(spec: NightSpec): Promise<Night> {
    const creator = spec.creator ?? this.host
    const id = await makeEvent(creator)
    this.events.push(id)
    const hours = spec.hours ?? 3
    const perDay = spec.guests ?? [0]
    const dayCount = Math.max(perDay.length, spec.staff?.length ?? 0, 1)
    const end = new Date(spec.start.getTime() + (dayCount - 1) * DAY + hours * HOUR)
    await db.events.update({
      where: { id },
      data: {
        venue_id: spec.venue,
        organizer_org_id: spec.org ?? this.hostOrg,
        start_time: spec.start,
        end_time: end,
      },
    })

    const first = await db.event_occurrences.findFirstOrThrow({ where: { event_id: id }, select: { id: true } })
    const firstDay = spec.firstDay ?? spec.start.toISOString().slice(0, 10)
    const days: string[] = []
    for (let d = 0; d < dayCount; d++) {
      const start = new Date(spec.start.getTime() + d * DAY)
      const data = {
        occurs_on: new Date(new Date(`${firstDay}T00:00:00.000Z`).getTime() + d * DAY),
        start_time: start,
        end_time: new Date(start.getTime() + hours * HOUR),
      }
      if (d === 0) {
        await db.event_occurrences.update({ where: { id: first.id }, data })
        days.push(first.id)
      } else {
        const o = await db.event_occurrences.create({ data: { event_id: id, ...data }, select: { id: true } })
        days.push(o.id)
      }
    }

    const guests: string[][] = []
    for (let d = 0; d < dayCount; d++) {
      const people: string[] = []
      const checkIn = (user_id: string, kind: "attendee" | "staff", status = "checked_in") =>
        db.event_check_ins.create({
          data: {
            event_id: id,
            occurrence_id: days[d],
            user_id,
            kind,
            status: status as never,
            check_in_time: new Date(spec.start.getTime() + d * DAY + HOUR),
          },
        })
      for (let i = 0; i < (perDay[d] ?? 0); i++) {
        const g = await this.user(`vcw-g${d}-${i}`)
        await checkIn(g, "attendee")
        people.push(g)
      }
      for (let i = 0; i < (spec.staff?.[d] ?? 0); i++) await checkIn(await this.user(`vcw-s${d}-${i}`), "staff")
      if (d === 0) {
        for (const status of spec.statuses ?? []) {
          const g = await this.user(`vcw-st-${status}`)
          await checkIn(g, "attendee", status)
          if (status === "checked_out") people.push(g)
        }
      }
      guests.push(people)
    }

    const going = spec.going ?? 10
    const rsvpers = guests.flat().slice(0, going)
    while (rsvpers.length < going) rsvpers.push(await this.user("vcw-rsvp"))
    for (const user_id of rsvpers) {
      await db.event_rsvps.create({ data: { event_id: id, user_id, status: "going" } })
    }
    return { id, days, guests }
  }

  async teardown() {
    await db.events.updateMany({ where: { id: { in: this.events } }, data: { venue_id: null } })
    await db.presence_sessions.deleteMany({ where: { event_id: { in: this.events } } })
    await db.event_ratings.deleteMany({ where: { event_id: { in: this.events } } })
    await db.venues.deleteMany({ where: { id: { in: this.venues } } })
    await db.organisation_members.deleteMany({ where: { org_id: { in: this.orgs } } })
    await cleanup(this.users, this.events)
    await db.organisations.deleteMany({ where: { id: { in: this.orgs } } })
  }
}
