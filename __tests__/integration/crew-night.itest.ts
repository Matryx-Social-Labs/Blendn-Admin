/*
 * A night's crews, counted (S8, SCRUM-1101): the peak from check-in intervals,
 * the crews that came back to the same host, and the Mixes. Each figure has a
 * control: somebody who must not count, and does not.
 */
import { crewPeak, crewsBack, mixesMade } from "@/lib/crews/night"
import { insightCountsOf } from "@/lib/insight-tallies"
import { liveSocialCounts } from "@/lib/live-social"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

const MIN = 60_000
const DAY = 86_400_000
const users: string[] = []
const events: string[] = []
const crews: string[] = []
const orgs: string[] = []
const venues: string[] = []

afterAll(async () => {
  await db.blends.deleteMany({ where: { OR: [{ a_crew_id: { in: crews } }, { b_crew_id: { in: crews } }] } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await db.crew_members.deleteMany({ where: { crew_id: { in: crews } } })
  await db.crews.deleteMany({ where: { id: { in: crews } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

async function people(n: number) {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await makeUser(testId(`cn-${i}`)))
  users.push(...ids)
  return ids
}

async function night(data: Record<string, unknown> = {}) {
  const host = await makeUser(testId("cn-host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  if (Object.keys(data).length) await db.events.update({ where: { id: eventId }, data })
  return { eventId, occurrenceId: await occurrenceOf(eventId) }
}

async function crewOf(members: string[], over: { joined_at?: Date; hidden_at?: Date; dissolved_at?: Date } = {}) {
  const { joined_at, ...crewData } = over
  const crew = await db.crews.create({ data: { name: testId("cn").slice(0, 30), emblem_seed: "s", created_by: members[0], ...crewData } })
  crews.push(crew.id)
  await db.crew_members.createMany({ data: members.map((user_id, i) => ({ crew_id: crew.id, user_id, role: i === 0 ? "owner" : "member", consented_reveal_at: new Date(), ...(joined_at && { joined_at }) })) })
  return crew.id
}

const T0 = new Date("2026-11-20T16:03:20Z")
const at = (min: number) => new Date(T0.getTime() + min * MIN)

const stay = (room: { eventId: string; occurrenceId: string }, user_id: string, from: number, to: number | null, kind: "attendee" | "staff" = "attendee") =>
  db.presence_sessions.create({
    data: { event_id: room.eventId, occurrence_id: room.occurrenceId, user_id, kind, arrived_at: at(from), departed_at: to === null ? null : at(to) },
  })

describe("the peak", () => {
  it("is the most crews with two or more members here at once, when it was first reached, rounded down to ten minutes", async () => {
    const room = await night()
    const p = await people(6)
    await crewOf([p[0], p[1]])
    await crewOf([p[2], p[3]])
    await crewOf([p[4], p[5]])
    // A: 0-60 together. B: together from 37. C: together 70-80, once A has gone.
    await stay(room, p[0], 0, 60)
    await stay(room, p[1], 0, 60)
    await stay(room, p[2], 5, 100)
    await stay(room, p[3], 37, 65)
    await stay(room, p[4], 70, 80)
    await stay(room, p[5], 70, null)
    // 16:03:20 + 37 min = 16:40:20, so 16:40.
    expect(await crewPeak({ eventId: room.eventId })).toEqual({ crews: 2, people: 4, at: "2026-11-20T16:40:00.000Z" })
    expect(await crewPeak({ occurrenceId: room.occurrenceId })).toEqual(await crewPeak({ eventId: room.eventId }))
  })

  it("never counts one person as two members, a member who left as here, staff, or a hidden or dissolved crew", async () => {
    const room = await night()
    const p = await people(10)
    // One person, two sessions that overlap: not a crew. Their crewmate came after they left, at that very moment.
    await crewOf([p[0], p[1]])
    await stay(room, p[0], 0, 30)
    await stay(room, p[0], 10, 40)
    await stay(room, p[1], 40, 90)
    // Two who worked it.
    await crewOf([p[2], p[3]])
    await stay(room, p[2], 0, 50, "staff")
    await stay(room, p[3], 0, 50)
    // A crew a moderator hid, and one that ended.
    await crewOf([p[4], p[5]], { hidden_at: new Date() })
    await crewOf([p[6], p[7]], { dissolved_at: new Date() })
    for (const u of p.slice(4, 8)) await stay(room, u, 0, 50)
    expect(await crewPeak({ eventId: room.eventId })).toBeNull()
    // The control: the same stays in a crew that stands do count.
    await crewOf([p[4], p[6]])
    expect(await crewPeak({ eventId: room.eventId })).toMatchObject({ crews: 1, people: 2 })
  })

  it("counts a person in two crews once, and each crew", async () => {
    const room = await night()
    const p = await people(3)
    await crewOf([p[0], p[1]])
    await crewOf([p[0], p[2]])
    for (const u of p) await stay(room, u, 0, 20)
    expect(await crewPeak({ eventId: room.eventId })).toMatchObject({ crews: 2, people: 3 })
  })

  it("is the day's own when asked of one day", async () => {
    const room = await night()
    const second = await db.event_occurrences.create({
      data: { event_id: room.eventId, occurs_on: new Date("2099-01-01"), start_time: at(0), end_time: at(60) },
    })
    const p = await people(2)
    await crewOf(p)
    for (const u of p) await stay({ eventId: room.eventId, occurrenceId: second.id }, u, 0, 20)
    expect(await crewPeak({ occurrenceId: room.occurrenceId })).toBeNull()
    expect(await crewPeak({ occurrenceId: second.id })).toMatchObject({ crews: 1 })
  })
})

describe("crews back again", () => {
  const came = (room: { eventId: string; occurrenceId: string }, user_id: string) =>
    db.event_check_ins.create({ data: { event_id: room.eventId, occurrence_id: room.occurrenceId, user_id, status: "checked_out", check_in_time: new Date(), kind: "attendee" } })
  const earlier = { start_time: new Date(Date.now() - 10 * DAY), end_time: new Date(Date.now() - 10 * DAY + 3 * 3_600_000) }
  const org = async () => {
    const o = await db.organisations.create({ data: { display_name: testId("cn-org") } })
    orgs.push(o.id)
    return o.id
  }

  it("is the crews whose members came together to an earlier night of the same organization", async () => {
    const mine = await org()
    const theirs = await org()
    const tonight = await night({ organizer_org_id: mine })
    const before = await night({ organizer_org_id: mine, ...earlier })
    const rivals = await night({ organizer_org_id: theirs, ...earlier })
    const p = await people(12)
    const long = { joined_at: new Date(Date.now() - 30 * DAY) }
    await crewOf([p[0], p[1], p[2]], long) // back
    await crewOf([p[3], p[4]], long) // one of them alone before: not back
    await crewOf([p[5], p[6]], long) // at somebody else's night: not back
    await crewOf([p[7], p[8]]) // both before, but not a crew then: not back
    await crewOf([p[9], p[10]], long) // back before, one of them here tonight: did not come
    for (const u of p.slice(0, 10)) await came(tonight, u)
    for (const u of [p[0], p[1], p[3], p[7], p[8], p[9], p[10]]) await came(before, u)
    for (const u of [p[5], p[6]]) await came(rivals, u)
    expect(await crewsBack(tonight.eventId)).toEqual({ crews: 1, people: 3 })
    // Never counts forward: the earlier night has no earlier night.
    expect(await crewsBack(before.eventId)).toEqual({ crews: 0, people: 0 })
  })

  it("has nobody to compare with for an event of no organization", async () => {
    const room = await night()
    expect(await crewsBack(room.eventId)).toBeNull()
  })

  it("reads a venue day's own venue, and nothing from before its claim", async () => {
    const owner = await org()
    const venue = await db.venues.create({ data: { name: testId("cn-venue"), city: "Bengaluru", owner_org_id: owner, claimed_at: new Date(Date.now() - 20 * DAY) } })
    venues.push(venue.id)
    const day = { kind: "venue_day" as const, venue_id: venue.id, visibility: "unlisted" as const }
    const tonight = await night(day)
    const preClaim = await night({ ...day, start_time: new Date(Date.now() - 25 * DAY), end_time: new Date(Date.now() - 25 * DAY + 3_600_000) })
    const p = await people(2)
    await crewOf(p, { joined_at: new Date(Date.now() - 60 * DAY) })
    for (const u of p) {
      await came(tonight, u)
      await came(preClaim, u)
    }
    expect(await crewsBack(tonight.eventId)).toEqual({ crews: 0, people: 0 })
    await db.venues.update({ where: { id: venue.id }, data: { claimed_at: new Date(Date.now() - 40 * DAY) } })
    expect(await crewsBack(tonight.eventId)).toEqual({ crews: 1, people: 2 })
  })
})

describe("Mixes, and where the figures are read", () => {
  it("counts this night's Mixes, crew to crew and one more, open or closed, and hands every figure to both readers", async () => {
    const room = await night()
    const elsewhere = await night()
    const p = await people(5)
    const a = await crewOf([p[0], p[1]])
    const b = await crewOf([p[2], p[3]])
    const [x, y] = [a, b].sort()
    const closes_at = new Date(Date.now() + DAY)
    await db.blends.create({ data: { occurrence_id: room.occurrenceId, a_crew_id: x, b_crew_id: y, closes_at } })
    await db.blends.create({ data: { occurrence_id: room.occurrenceId, a_crew_id: a, b_user_id: p[4], closes_at, closed_at: new Date() } })
    await db.blends.create({ data: { occurrence_id: elsewhere.occurrenceId, a_crew_id: x, b_crew_id: y, closes_at } })
    for (const userId of p) await putInRoom({ ...room, userId })

    expect(await mixesMade({ eventId: room.eventId })).toBe(2)
    const tally = await insightCountsOf(room.eventId)
    expect(tally.crews).toMatchObject({ came: 2, people: 4, back: null, mixes: 2, peak: { crews: 2, people: 4 } })
    const live = await liveSocialCounts(room.eventId, room.occurrenceId)
    expect(live.crews).toMatchObject({ here: 2, people: 4, guests: 5, mixes: 2, peak: { crews: 2 } })
    // Never an id: the wire takes these through the floors, and the tally is stored as is.
    expect(JSON.stringify(tally.crews)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
  })
})
