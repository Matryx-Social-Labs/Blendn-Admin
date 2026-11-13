/**
 * "Going together" (crews NOTES §6 S4, owner 4-A1 / 1b): a crew marks a night.
 * One line and one push per crew per night, who is going from each member's
 * own RSVP, members only — never a stranger, never a host.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-redesign-secret-of-32-characters-x"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { resetMemoryStore } from "@/lib/rate-limit-store"
import { db } from "./helpers"
import { api, call, cleanupCrewWorld, crewOf, liveEvent, person, type Person } from "./crew-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const plansRoute = require("@/app/api/mobile/crews/[crewId]/plans/route") as typeof import("@/app/api/mobile/crews/[crewId]/plans/route")
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

beforeEach(() => resetMemoryStore())
// A plan goes with its crew (ON DELETE CASCADE).
afterAll(() => cleanupCrewWorld())

const plan = (as: Person, crewId: string, eventId: string) =>
  call(plansRoute.POST, `/api/mobile/crews/${crewId}/plans`, as, { method: "POST", body: { eventId }, params: { crewId } })
const unplan = (as: Person, crewId: string, eventId: string) =>
  call(plansRoute.DELETE, `/api/mobile/crews/${crewId}/plans`, as, { method: "DELETE", body: { eventId }, params: { crewId } })
const detail = (as: Person, eventId: string) => call(eventRoute.GET, `/api/mobile/events/${eventId}`, as, { params: { eventId } })
const going = (as: Person, eventId: string) => db.event_rsvps.create({ data: { event_id: eventId, user_id: as.id, status: "going" } })
const pushes = (userId: string) => db.notifications.findMany({ where: { kind: "crew_here", user_id: userId }, select: { title: true, body: true } })

describe("Going together (S4)", () => {
  it("marks the night once: one line, one push to the rest, never the place", async () => {
    const host = await person("gt-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const priya = await person("gt-priya", "Priya Raman")
    const arjun = await person("gt-arjun", "Arjun Mehta")
    const meera = await person("gt-meera", "Meera Iyer")
    const { crewId, roomId } = await crewOf(priya, [arjun, meera], "Nebula")
    const title = (await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { title: true } })).title

    const first = await plan(priya, crewId, eventId)
    expect(first.status).toBe(200)
    expect(first.body.data).toEqual({ planned: true, repeated: false, occurrenceId })
    const line = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: roomId, type: "system" }, select: { user_id: true, metadata: true } })
    expect(line).toEqual({ user_id: priya.id, metadata: { kind: "crew_plan", eventId, occurrenceId } })
    for (const p of [arjun, meera]) {
      const got = await pushes(p.id)
      expect(got).toEqual([{ title: "Nebula", body: "Priya wants to go together. Open the crew to see the night." }])
      expect(got[0].body).not.toContain(title)
    }
    expect(await pushes(priya.id)).toEqual([])

    // A second member marking the same night: the same plan, nobody told twice.
    expect((await plan(arjun, crewId, eventId)).body.data).toEqual({ planned: true, repeated: true, occurrenceId })
    expect(await pushes(meera.id)).toHaveLength(1)
    expect(await db.crew_plans.count({ where: { crew_id: crewId } })).toBe(1)

    // The crew page lists it.
    const page = await api.detail(meera, crewId)
    expect(page.body.data.plans).toEqual([expect.objectContaining({ eventId, title, occurrenceId })])
  })

  it("myCrewPlans names crewmates going by their own RSVP, as the crew room shows them; a stranger gets none", async () => {
    const host = await person("gt2-host")
    const { eventId } = await liveEvent(host.id)
    const priya = await person("gt2-priya", "Priya Raman")
    const arjun = await person("gt2-arjun", "Arjun Hidden Mehta")
    const meera = await person("gt2-meera", "Meera Iyer")
    const blocked = await person("gt2-rhea", "Rhea Blocked")
    const stranger = await person("gt2-x", "Omar Stranger")
    const { crewId } = await crewOf(priya, [arjun, meera, blocked], "Orbit")
    await db.user.update({ where: { id: arjun.id }, data: { image: "https://img.invalid/arjun.jpg" } })
    expect((await api.settings(arjun, crewId, true)).status).toBe(200)
    for (const p of [priya, arjun, blocked, stranger]) await going(p, eventId)
    expect((await api.block(priya, blocked.id)).status).toBe(200)
    await plan(meera, crewId, eventId)

    const mine = await detail(priya, eventId)
    expect(mine.status).toBe(200)
    const plans = mine.body.data.userStatus.myCrewPlans
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ crewId, name: "Orbit" })
    // Meera planned it but is not going (no RSVP); Rhea is blocked by Priya.
    expect(plans[0].going.map((g: { name: string }) => g.name)).toEqual(expect.arrayContaining(["Priya", "Arjun"]))
    expect(plans[0].going).toHaveLength(2)
    const arjunRow = plans[0].going.find((g: { name: string }) => g.name === "Arjun")
    expect(arjunRow.photo).toBeNull()
    expect(arjunRow.userId).not.toBe(arjun.id)
    expect(JSON.stringify(plans)).not.toContain("Hidden")

    // A stranger going to the same event: nothing of anybody's crew.
    const theirs = await detail(stranger, eventId)
    expect(theirs.body.data.userStatus.myCrewPlans).toEqual([])
    expect(JSON.stringify(theirs.body)).not.toContain("Orbit")
  })

  it("never plans, or shows the title of, an event the member cannot get into: private, or age-gated", async () => {
    const host = await person("gt4-host")
    const priya = await person("gt4-priya", "Priya Raman")
    const young = await person("gt4-young", "Young Member")
    const { crewId, roomId } = await crewOf(priya, [young], "Nebula")
    await db.profiles.update({ where: { id: young.id }, data: { age: 19, date_of_birth: new Date(Date.now() - 19.5 * 365.25 * 86_400_000) } })

    // A private event Priya was not let into: refused as if it did not exist, nothing written.
    const hidden = await liveEvent(host.id)
    const HIDDEN_TITLE = "Secret Rooftop Session"
    await db.events.update({ where: { id: hidden.eventId }, data: { visibility: "private", title: HIDDEN_TITLE } })
    expect((await plan(priya, crewId, hidden.eventId)).status).toBe(404)
    expect(await db.crew_plans.count({ where: { crew_id: crewId } })).toBe(0)

    // A 21+ night Priya may attend and her 19-year-old crewmate may not.
    const gated = await liveEvent(host.id)
    const GATED_TITLE = "Whisky Tasting 21 Plus"
    await db.events.update({ where: { id: gated.eventId }, data: { min_age: 21, title: GATED_TITLE } })
    // Control: a public night everyone may see.
    const open = await liveEvent(host.id)
    const openTitle = (await db.events.findUniqueOrThrow({ where: { id: open.eventId }, select: { title: true } })).title
    expect((await plan(priya, crewId, gated.eventId)).status).toBe(200)
    expect((await plan(priya, crewId, open.eventId)).status).toBe(200)

    // The young member's crew page lists the open night, never the gated one's title.
    const theirs = await api.detail(young, crewId)
    expect(theirs.body.data.plans.map((p: { title: string }) => p.title)).toEqual([openTitle])
    expect(JSON.stringify(theirs.body)).not.toContain(GATED_TITLE)
    // Priya's lists both.
    expect((await api.detail(priya, crewId)).body.data.plans).toHaveLength(2)
    // The chat line names no event: its id only, which the event door refuses them.
    const read = await api.read(young, roomId)
    expect(JSON.stringify(read.body)).not.toContain(GATED_TITLE)
    expect((await detail(young, gated.eventId)).status).not.toBe(200)
  })

  it("plan, take back, plan again: one push and one line for the night, and the day's cap still counts", async () => {
    const host = await person("gt5-host")
    const events = await Promise.all([0, 1, 2, 3].map(() => liveEvent(host.id)))
    const owner = await person("gt5-owner")
    const mate = await person("gt5-mate")
    const { crewId, roomId } = await crewOf(owner, [mate], "Looped")
    const lines = () => db.chat_messages.count({ where: { chat_group_id: roomId, type: "system", metadata: { path: ["kind"], equals: "crew_plan" } } })

    for (let i = 0; i < 3; i++) {
      expect((await plan(owner, crewId, events[0].eventId)).status).toBe(200)
      await unplan(owner, crewId, events[0].eventId)
    }
    expect((await plan(owner, crewId, events[0].eventId)).status).toBe(200)
    // Control: the night is planned, and the crew was told once.
    expect(await db.crew_plans.count({ where: { crew_id: crewId } })).toBe(1)
    expect(await pushes(mate.id)).toHaveLength(1)
    expect(await lines()).toBe(1)

    // Taking plans back never refunds the day's cap: two more nights, then refused.
    for (const e of events.slice(1, 3)) {
      expect((await plan(owner, crewId, e.eventId)).status).toBe(200)
      await unplan(owner, crewId, e.eventId)
    }
    expect((await plan(owner, crewId, events[3].eventId)).status).toBe(429)
    expect(await pushes(mate.id)).toHaveLength(3)
  })

  it("is members only, refuses crews off, caps at 3 nights a day, and is taken back only by its planner or the owner", async () => {
    const host = await person("gt3-host")
    const events = await Promise.all([0, 1, 2, 3].map(() => liveEvent(host.id)))
    const owner = await person("gt3-owner")
    const mate = await person("gt3-mate")
    const other = await person("gt3-other")
    const stranger = await person("gt3-x")
    const { crewId } = await crewOf(owner, [mate, other], "Capped")

    expect((await plan(stranger, crewId, events[0].eventId)).status).toBe(404)
    await db.events.update({ where: { id: events[3].eventId }, data: { crews_enabled: false } })
    expect((await plan(mate, crewId, events[3].eventId)).status).toBe(403)
    await db.events.update({ where: { id: events[3].eventId }, data: { crews_enabled: true } })

    for (const e of events.slice(0, 3)) expect((await plan(mate, crewId, e.eventId)).status).toBe(200)
    expect((await plan(mate, crewId, events[3].eventId)).status).toBe(429)

    // Someone else's plan: a member who did not mark it cannot take it back.
    await unplan(other, crewId, events[0].eventId)
    expect(await db.crew_plans.count({ where: { crew_id: crewId, occurrence_id: events[0].occurrenceId } })).toBe(1)
    // Its planner can; so can the owner.
    await unplan(mate, crewId, events[0].eventId)
    expect(await db.crew_plans.count({ where: { crew_id: crewId, occurrence_id: events[0].occurrenceId } })).toBe(0)
    await unplan(owner, crewId, events[1].eventId)
    expect(await db.crew_plans.count({ where: { crew_id: crewId, occurrence_id: events[1].occurrenceId } })).toBe(0)
  })
})
