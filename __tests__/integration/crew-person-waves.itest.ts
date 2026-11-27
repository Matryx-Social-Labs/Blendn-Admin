/**
 * A crew's wave at one person (crews 5-A, S5 part b2): `POST /events/:id/waves
 * { toUserId, asCrewId }`. Stored as a crew → person `crew_likes` row with
 * `is_wave`, shown to the person — `crewWaves` on their room list, `crewRooms`
 * on Banter, a `room:crew_wave` ping, the crew card's `wavedAtYou` — and
 * answered with the person's wave at the crew, which opens the Mix. The C7
 * rule holds for the waver: every refusal about the person is the answer of a
 * wave that stood, and stores nothing. No line in the crew chat, no push.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-crew-person-waves-secret-32-chars-x"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { SYSTEM_USER_ID } from "@/lib/event-kind"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { roomHandle } from "@/lib/room-handle"

import { db } from "./helpers"
import { api, arrive, cleanupCrewWorld, crewOf, liveEvent, person, socketHarness, until, type Person } from "./crew-world"

const sockets = socketHarness()
beforeAll(() => sockets.start())
beforeEach(() => resetMemoryStore())
afterAll(async () => {
  await sockets.stop()
  await cleanupCrewWorld()
})

async function world(label: string) {
  const host = await person(`${label}-host`)
  const { eventId, occurrenceId } = await liveEvent(host.id)
  const make = async (tag: string, name: string) => {
    const people = await Promise.all([0, 1].map((i) => person(`${label}-${tag}${i}`, `${name}person${i} Rao`)))
    const crew = await crewOf(people[0], [people[1]], name)
    await db.crews.update({ where: { id: crew.crewId }, data: { open_to_solo: true, intent: ["friendship"] } })
    for (const p of people) await arrive(eventId, occurrenceId, p)
    return { ...crew, people }
  }
  const nebula = await make("n", "Nebula")
  const orbit = await make("o", "Orbit")
  const solo = await person(`${label}-meera`, "Meera Iyer")
  await arrive(eventId, occurrenceId, solo, "Lunar Fox")
  await api.prefs(solo, eventId, { openToCrews: true })
  return { eventId, occurrenceId, nebula, orbit, solo, handle: roomHandle(eventId, solo.id) }
}

const crewRows = (crewId: string, userId: string) => db.crew_likes.findMany({ where: { from_crew_id: crewId, to_user_id: userId }, select: { is_wave: true } })
const systemLines = (roomIds: string[]) => db.chat_messages.count({ where: { chat_group_id: { in: roomIds }, type: "system" } })
const notesOf = (people: Person[]) => db.notifications.count({ where: { user_id: { in: people.map((p) => p.id) } } })
const STOOD = { status: 200, body: expect.objectContaining({ data: { sent: true, mutual: false } }) }

describe("Wave at a person for your crew", () => {
  it("is shown to the person — list, Banter, ping, card — tells nobody else, and their wave back opens the Mix", async () => {
    const w = await world("cpw")
    const everyone = [...w.nebula.people, ...w.orbit.people, w.solo]
    const before = await notesOf(everyone)
    const linesBefore = await systemLines([w.nebula.roomId, w.orbit.roomId])
    const meera = await sockets.online(w.solo)
    const pings: unknown[] = []
    meera.socket.on("room:crew_wave", (p) => pings.push(p))

    const res = await api.wave(w.nebula.people[0], w.eventId, w.handle, w.nebula.crewId)
    expect(res).toEqual(STOOD)
    expect(await crewRows(w.nebula.crewId, w.solo.id)).toEqual([{ is_wave: true }])
    expect(await until(() => pings.length === 1)).toBe(true)
    expect(pings[0]).toEqual({ eventId: w.eventId, fromCrewId: w.nebula.crewId, fromName: "Nebula" })

    // Her room list: the crew, apart from the people (an installed build's count still matches its list).
    const list = (await api.waves(w.solo, w.eventId)).body.data
    expect(list).toMatchObject({ open: true, total: 0, waves: [], crewTotal: 1 })
    expect(list.crewWaves).toEqual([
      { crewId: w.nebula.crewId, name: "Nebula", emblemSeed: expect.any(String), wavedAt: expect.any(String), wavedBack: false },
    ])
    // Banter: a crew room row, the person rows untouched.
    const banter = (await api.wavesWaiting(w.solo)).body.data
    expect(banter.rooms).toEqual([])
    expect(banter.crewRooms).toEqual([{ eventId: w.eventId, waiting: 1, latest: list.crewWaves[0] }])
    // The card in her Crews view is pinned and lit.
    const cards = (await api.atEvent(w.solo, w.eventId)).body.data.crews as Record<string, unknown>[]
    expect(cards[0]).toMatchObject({ crewId: w.nebula.crewId, wavedAtYou: true })

    // C7: no line in either crew chat, and nobody pushed. A second wave is the first.
    expect(await systemLines([w.nebula.roomId, w.orbit.roomId])).toBe(linesBefore)
    expect(await notesOf(everyone)).toBe(before)
    expect(await api.wave(w.nebula.people[1], w.eventId, w.handle, w.nebula.crewId)).toEqual(STOOD)
    expect(await crewRows(w.nebula.crewId, w.solo.id)).toHaveLength(1)
    expect(pings).toHaveLength(1)

    // Her wave back: the Mix, "both waved", and the row is answered.
    const back = await api.waveCrew(w.solo, w.eventId, w.nebula.crewId)
    expect(back.body.data.blend).toEqual({ blendId: expect.any(String), chatGroupId: expect.any(String) })
    const note = await db.notifications.findFirst({ where: { user_id: w.nebula.people[1].id, title: "It’s a Mix" }, select: { body: true } })
    expect(note?.body).toBe("Someone here and Nebula both waved. Say hi in the Mix.")
    expect((await api.waves(w.solo, w.eventId)).body.data.crewWaves[0]).toMatchObject({ wavedBack: true })
    expect((await api.wavesWaiting(w.solo)).body.data.crewRooms).toEqual([])
  })

  it("answers every refusal about the person as a wave that stood, and stores nothing", async () => {
    const w = await world("cpw7")
    const shy = await person("cpw7-shy")
    await arrive(w.eventId, w.occurrenceId, shy)
    const blocker = await person("cpw7-blocker")
    await arrive(w.eventId, w.occurrenceId, blocker)
    await api.prefs(blocker, w.eventId, { openToCrews: true })
    await api.block(blocker, w.nebula.people[1].id)

    // Not opted in, blocked one of the crew, your own crewmate's room handle (SCRUM-1476: a 404 said
    // "this handle is in my crew"): one answer.
    for (const handle of [roomHandle(w.eventId, shy.id), roomHandle(w.eventId, blocker.id), roomHandle(w.eventId, w.nebula.people[1].id)]) {
      expect(await api.wave(w.nebula.people[0], w.eventId, handle, w.nebula.crewId)).toEqual(STOOD)
    }
    expect(await db.crew_likes.count({ where: { from_crew_id: w.nebula.crewId } })).toBe(0)
    expect((await api.waves(shy, w.eventId)).body.data).toMatchObject({ crewTotal: 0, crewWaves: [] })
    // Control: the opted-in person is waved at.
    expect(await api.wave(w.nebula.people[0], w.eventId, w.handle, w.nebula.crewId)).toEqual(STOOD)
    expect(await crewRows(w.nebula.crewId, w.solo.id)).toHaveLength(1)
  })

  it("a like from before is upgraded and told once; a crew's own refusals say so", async () => {
    const w = await world("cpwl")
    await api.likePerson(w.orbit.people[0], w.eventId, w.handle, w.orbit.crewId)
    expect((await api.waves(w.solo, w.eventId)).body.data.crewTotal).toBe(0)
    await api.wave(w.orbit.people[1], w.eventId, w.handle, w.orbit.crewId)
    expect(await crewRows(w.orbit.crewId, w.solo.id)).toEqual([{ is_wave: true }])
    expect((await api.waves(w.solo, w.eventId)).body.data.crewWaves.map((c: { name: string }) => c.name)).toEqual(["Orbit"])

    // A crew with no room for one more is told why, and the person is never read.
    await db.crews.update({ where: { id: w.nebula.crewId }, data: { open_to_solo: false } })
    const refused = await api.wave(w.nebula.people[0], w.eventId, w.handle, w.nebula.crewId)
    expect(refused.status).toBe(403)
  })

  it("leaves the person's list when a block lands, or when she hides the crew; another crew stays", async () => {
    const w = await world("cpwv")
    await api.wave(w.nebula.people[0], w.eventId, w.handle, w.nebula.crewId)
    await api.wave(w.orbit.people[0], w.eventId, w.handle, w.orbit.crewId)
    const names = async () => ((await api.waves(w.solo, w.eventId)).body.data.crewWaves as { name: string }[]).map((c) => c.name).sort()
    expect(await names()).toEqual(["Nebula", "Orbit"])

    await api.block(w.nebula.people[1], w.solo.id)
    expect(await names()).toEqual(["Orbit"])
    expect((await api.hide(w.solo, w.orbit.crewId)).status).toBe(200)
    expect(await names()).toEqual([])
    expect((await api.wavesWaiting(w.solo)).body.data.crewRooms).toEqual([])
  })
})

it("nobody but the person is shown it: no line from the system user anywhere", async () => {
  const w = await world("cpwn")
  await api.wave(w.nebula.people[0], w.eventId, w.handle, w.nebula.crewId)
  expect(await db.chat_messages.count({ where: { user_id: SYSTEM_USER_ID, chat_group_id: { in: [w.nebula.roomId, w.orbit.roomId] } } })).toBe(0)
  expect((await api.waves(w.orbit.people[0], w.eventId)).body.data).toMatchObject({ crewTotal: 0 })
})
