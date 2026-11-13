/**
 * Arrive together (crews NOTES §6 S1–S3, owner 1A): "With {crew}" at your own
 * hold tells the crew with no second tap; the crew's strip names who is in
 * with it; the push names who is in, never who is not, never where.
 *
 * Every check-in here goes through the real door with a GPS fix: the hold is
 * the only check-in, and nobody is checked in by anybody else (CR-I04).
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-redesign-secret-of-32-characters-x"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { resetMemoryStore } from "@/lib/rate-limit-store"
import { db, testId } from "./helpers"
import { api, call, cleanupCrewWorld, crewOf, person, world, type Person } from "./crew-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const LAT = 12.9716
const LNG = 77.5946
const VENUE = "Toit Brewpub Indiranagar"

beforeEach(() => resetMemoryStore())
afterAll(() => cleanupCrewWorld())

/** A live event with a fence at (LAT, LNG), its room and its one occurrence. */
async function fencedEvent(host: Person) {
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("arr"),
      title: `${VENUE} night`,
      description: "integration fixture",
      start_time: new Date(now - 30 * 60_000),
      end_time: new Date(now + 2 * 60 * 60_000),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: host.id,
      latitude: LAT,
      longitude: LNG,
      geofence: { type: "circle", lat: LAT, lng: LNG, radius: 60, buffer: 20 },
    },
  })
  world.events.push(event.id)
  await db.chat_groups.create({ data: { event_id: event.id, name: "room" } })
  await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(event.start_time.toISOString().slice(0, 10)), start_time: event.start_time, end_time: event.end_time },
  })
  return event.id
}

const hold = (eventId: string, p: Person, withCrewId?: string) =>
  call(checkinRoute.POST, `/api/mobile/events/${eventId}/checkin`, p, {
    method: "POST",
    body: { latitude: LAT, longitude: LNG, ...(withCrewId && { withCrewId }) },
    params: { eventId },
  })

const pushesTo = (userId: string) =>
  db.notifications.findMany({ where: { kind: "crew_here", user_id: userId }, select: { body: true, title: true }, orderBy: { created_at: "asc" } })

const strip = async (p: Person, eventId: string, crewId: string) => {
  const res = await api.atEvent(p, eventId)
  expect(res.status).toBe(200)
  return (res.body.data.myCrews as { crewId: string; here: { userId: string; name: string; you: boolean }[] }[]).find((c) => c.crewId === crewId)
}

describe("With {crew} at the hold (S1)", () => {
  it("tells the crew on your own check-in — one line, one push each — and checks nobody else in", async () => {
    const host = await person("arr-host")
    const eventId = await fencedEvent(host)
    const priya = await person("arr-priya", "Priya Raman")
    const arjun = await person("arr-arjun", "Arjun Mehta")
    const meera = await person("arr-meera", "Meera Iyer")
    const { crewId, roomId } = await crewOf(priya, [arjun, meera], "Nebula")

    const res = await hold(eventId, priya, crewId)
    expect(res.status).toBe(200)
    expect(res.body.data.crewTold).toBe(true)

    // Nobody else is checked in by it.
    expect(await db.event_check_ins.count({ where: { event_id: eventId, user_id: { in: [arjun.id, meera.id] } } })).toBe(0)
    // The crew chat line, once, by Priya.
    const lines = await db.chat_messages.findMany({ where: { chat_group_id: roomId, type: "system" }, select: { user_id: true, metadata: true } })
    expect(lines).toHaveLength(1)
    expect(lines[0].user_id).toBe(priya.id)
    expect(lines[0].metadata).toMatchObject({ kind: "crew_here", eventId })
    // The push names who is in, never where, and tells the others to hold when they get there.
    for (const p of [arjun, meera]) {
      const told = await pushesTo(p.id)
      expect(told).toEqual([{ title: "Nebula", body: "Priya is in. Hold to Blend’n when you get there." }])
    }
    expect(await pushesTo(priya.id)).toEqual([])

    // A second hold the same night: already told, nobody pushed twice.
    expect((await hold(eventId, priya, crewId)).body.data.crewTold).toBe(true)
    expect(await pushesTo(arjun.id)).toHaveLength(1)
  })

  it("names everyone in, and leaves the hold line off for a crewmate already in", async () => {
    const host = await person("arr2-host")
    const eventId = await fencedEvent(host)
    const priya = await person("arr2-priya", "Priya Raman")
    const arjun = await person("arr2-arjun", "Arjun Mehta")
    const meera = await person("arr2-meera", "Meera Iyer")
    const { crewId } = await crewOf(priya, [arjun, meera], "Nebula")

    await hold(eventId, priya, crewId)
    await hold(eventId, arjun, crewId)
    // Priya is in already: she gets the names, not "hold when you get there".
    expect((await pushesTo(priya.id)).map((p) => p.body)).toEqual(["Arjun is in."])
    // Meera is not in yet: both names, then the hold line.
    expect((await pushesTo(meera.id)).map((p) => p.body)).toEqual([
      "Priya is in. Hold to Blend’n when you get there.",
      "Priya and Arjun are in. Hold to Blend’n when you get there.",
    ])
    for (const p of await pushesTo(meera.id)) expect(p.body).not.toContain(VENUE)
  })

  it("a crew that is not yours, or no crew at all: the check-in is the same, and nobody is told", async () => {
    const host = await person("arr3-host")
    const eventId = await fencedEvent(host)
    const owner = await person("arr3-owner", "Kabir Das")
    const mate = await person("arr3-mate", "Ira Sen")
    const outsider = await person("arr3-out", "Zoya Khan")
    const { crewId, roomId } = await crewOf(owner, [mate], "Orbit")

    const theirs = await hold(eventId, outsider, crewId)
    expect(theirs.status).toBe(200)
    expect(theirs.body.data.crewTold).toBe(false)
    // A crew that does not exist answers the same.
    const none = await hold(eventId, owner, "00000000-0000-4000-8000-000000000000")
    expect(none.status).toBe(200)
    expect(none.body.data.crewTold).toBe(false)
    // Control: a hold without a crew tells nobody either, and answers in the old shape.
    expect((await hold(eventId, mate)).body.data).not.toHaveProperty("crewTold")
    expect(await db.chat_messages.count({ where: { chat_group_id: roomId, type: "system" } })).toBe(0)
    expect(await pushesTo(owner.id)).toEqual([])
    expect(await pushesTo(mate.id)).toEqual([])
  })

  it("crews off at the event: checked in, crew not told", async () => {
    const host = await person("arr4-host")
    const eventId = await fencedEvent(host)
    await db.events.update({ where: { id: eventId }, data: { crews_enabled: false } })
    const owner = await person("arr4-owner")
    const mate = await person("arr4-mate")
    const { crewId } = await crewOf(owner, [mate], "Offline")
    const res = await hold(eventId, owner, crewId)
    expect(res.status).toBe(200)
    expect(res.body.data.crewTold).toBe(false)
    expect(await pushesTo(mate.id)).toEqual([])
  })
})

describe("The crew's strip names who is in with it (S2)", () => {
  it("lists crewmates who came in with the crew, first in first — not one who came on their own, not one kept apart", async () => {
    const host = await person("str-host")
    const eventId = await fencedEvent(host)
    const priya = await person("str-priya", "Priya Raman")
    const arjun = await person("str-arjun", "Arjun Mehta")
    const solo = await person("str-solo", "Dev Solo")
    const blocked = await person("str-blocked", "Rhea Blocked")
    const { crewId } = await crewOf(priya, [arjun, solo, blocked], "Nebula")

    expect((await api.block(arjun, blocked.id)).status).toBe(200)
    await hold(eventId, priya, crewId)
    await hold(eventId, arjun, crewId)
    await hold(eventId, blocked, crewId)
    // Came in on their own: checked in, the crew not told.
    expect((await hold(eventId, solo)).body.data).not.toHaveProperty("crewTold")

    const mine = await strip(priya, eventId, crewId)
    expect(mine!.here.map((h) => h.name)).toEqual(["Priya", "Arjun", "Rhea"])
    expect(mine!.here.map((h) => h.you)).toEqual([true, false, false])
    // Yours real, everyone else's as a crew-room handle — never an account id.
    expect(mine!.here[0].userId).toBe(priya.id)
    expect(mine!.here[1].userId).not.toBe(arjun.id)
    // Arjun blocked Rhea: she is not on his strip.
    expect((await strip(arjun, eventId, crewId))!.here.map((h) => h.name)).toEqual(["Priya", "Arjun"])
    // The solo member sees the strip, without themselves on it.
    expect((await strip(solo, eventId, crewId))!.here.map((h) => h.name)).toEqual(["Priya", "Arjun", "Rhea"])
    // Rhea's pushes never name Arjun, nor his hers: a block holds across any member.
    expect((await pushesTo(blocked.id)).map((p) => p.body).join(" ")).not.toContain("Arjun")
    expect((await pushesTo(arjun.id)).map((p) => p.body).join(" ")).not.toContain("Rhea")
    // Control: Priya's pushes name both.
    expect((await pushesTo(priya.id)).map((p) => p.body)).toEqual(["Arjun is in.", "Arjun and Rhea are in."])
  })

  it("a stranger in the room sees the crew as a card with counts, never who", async () => {
    const host = await person("strc-host")
    const eventId = await fencedEvent(host)
    const a = await person("strc-a", "Tara Nair")
    const b = await person("strc-b", "Kiran Rao")
    const stranger = await person("strc-x", "Omar Stranger")
    const { crewId } = await crewOf(a, [b], "Visible")
    await db.crews.update({ where: { id: crewId }, data: { open_to_solo: true } })
    await hold(eventId, a, crewId)
    await hold(eventId, b, crewId)
    await hold(eventId, stranger)
    await db.event_match_preferences.upsert({
      where: { event_id_user_id: { event_id: eventId, user_id: stranger.id } },
      create: { event_id: eventId, user_id: stranger.id, intent: ["friendship"], open_to_crews_until: new Date(Date.now() + 3_600_000) },
      update: { open_to_crews_until: new Date(Date.now() + 3_600_000) },
    })
    const seen = await api.atEvent(stranger, eventId)
    expect(seen.status).toBe(200)
    // Control: the card is there, so the absence below means something.
    expect(seen.body.data.crews.map((c: { crewId: string }) => c.crewId)).toEqual([crewId])
    expect(seen.body.data.crews[0].presentCount).toBe(2)
    const body = JSON.stringify(seen.body)
    for (const leak of ["Tara", "Kiran", a.id, b.id, '"here"']) expect(body).not.toContain(leak)
  })
})
