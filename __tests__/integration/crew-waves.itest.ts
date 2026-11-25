/**
 * Crew waves (crews 5-A, S5) and "Block" on a crew (hide for good). A wave is
 * the crew like the other side is shown: a line in their crew chat, their
 * card pinned with `wavedAtYou`; a wave or a like back opens the one Mix. No
 * push for a single wave. A hide is the hider's alone.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-crew-waves-secret-of-32-characters-x"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { SYSTEM_USER_ID } from "@/lib/event-kind"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { roomHandle } from "@/lib/room-handle"

import { db } from "./helpers"
import { api, arrive, cleanupCrewWorld, crewOf, liveEvent, person, socketHarness, until, type Person } from "./crew-world"

const sockets = socketHarness()
beforeEach(() => resetMemoryStore())
beforeAll(() => sockets.start())
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
    for (const p of people) await arrive(eventId, occurrenceId, p)
    return { ...crew, people }
  }
  const nebula = await make("n", "Nebula")
  const orbit = await make("o", "Orbit")
  const comet = await make("c", "Comet")
  return { eventId, occurrenceId, nebula, orbit, comet }
}

const lines = (roomId: string) =>
  db.chat_messages.findMany({ where: { chat_group_id: roomId }, orderBy: { created_at: "asc" }, select: { user_id: true, content: true, metadata: true } })
/** The crew_waved lines of a room as its history gives them to one person. */
const wavedLines = async (as: Person, roomId: string) =>
  ((await api.read(as, roomId)).body.data.messages as { id: string; content: string; metadata: Record<string, unknown> | null; answered?: boolean }[]).filter(
    (m) => m.metadata?.kind === "crew_waved"
  )
const roomRow = async (as: Person, roomId: string) =>
  ((await api.chatGroups(as)).body.data.rooms as { id: string; unreadCount: number; lastMessage: { content: string } | null }[]).find((r) => r.id === roomId)
const cardsFor = async (as: Person, eventId: string) => (await api.atEvent(as, eventId)).body.data.crews as Record<string, unknown>[]
const notesOf = (people: Person[]) => db.notifications.count({ where: { user_id: { in: people.map((p) => p.id) } } })

describe("Wave for {crew}", () => {
  it("tells the crew waved at — a line and a pinned card — pushes nobody, and a wave back opens the Mix", async () => {
    const w = await world("wave")
    const everyone = [...w.nebula.people, ...w.orbit.people, ...w.comet.people]
    const before = await notesOf(everyone)

    const res = await api.waveCrew(w.nebula.people[0], w.eventId, w.orbit.crewId, w.nebula.crewId)
    expect(res).toEqual({ status: 200, body: expect.objectContaining({ data: { liked: true, waved: true, blend: null } }) })
    expect(await db.crew_likes.findFirst({ where: { from_crew_id: w.nebula.crewId, to_crew_id: w.orbit.crewId }, select: { is_wave: true } })).toEqual({
      is_wave: true,
    })

    // Their chat: from the system user (a stranger's name is never resolved there), with what Wave back needs.
    expect(await lines(w.orbit.roomId)).toContainEqual({
      user_id: SYSTEM_USER_ID,
      content: "Nebula waved at your crew",
      metadata: { kind: "crew_waved", eventId: w.eventId, occurrenceId: w.occurrenceId, fromCrewId: w.nebula.crewId },
    })
    // Our chat: who tapped, as a crew like says it.
    expect(await lines(w.nebula.roomId)).toContainEqual(
      expect.objectContaining({ user_id: w.nebula.people[0].id, content: "waved at Orbit for the crew", metadata: { kind: "crew_wave" } })
    )

    // Orbit's cards: Nebula pinned first, lit; Comet (no wave) is not.
    const orbitCards = await cardsFor(w.orbit.people[1], w.eventId)
    expect(orbitCards[0]).toMatchObject({ crewId: w.nebula.crewId, wavedAtYou: true, youWaved: false, youLiked: false })
    expect(orbitCards.find((c) => c.crewId === w.comet.crewId)).toMatchObject({ wavedAtYou: false })
    // Nebula's: ✓ Waved. Comet saw nothing.
    expect((await cardsFor(w.nebula.people[1], w.eventId)).find((c) => c.crewId === w.orbit.crewId)).toMatchObject({ youWaved: true, youLiked: true, wavedAtYou: false })
    expect((await cardsFor(w.comet.people[0], w.eventId)).every((c) => c.wavedAtYou === false)).toBe(true)
    expect(await notesOf(everyone)).toBe(before)

    // A second wave is the first: no second line.
    await api.waveCrew(w.nebula.people[1], w.eventId, w.orbit.crewId, w.nebula.crewId)
    expect((await lines(w.orbit.roomId)).filter((l) => l.content === "Nebula waved at your crew")).toHaveLength(1)

    // Wave back: the Mix, "both waved", and no "waved at your crew" line for a wave that made it.
    const back = await api.waveCrew(w.orbit.people[0], w.eventId, w.nebula.crewId, w.orbit.crewId)
    expect(back.status).toBe(200)
    expect(back.body.data.blend).toEqual({ blendId: expect.any(String), chatGroupId: expect.any(String) })
    expect((await lines(w.nebula.roomId)).some((l) => l.content === "Orbit waved at your crew")).toBe(false)
    const mixNote = await db.notifications.findFirst({ where: { user_id: w.nebula.people[1].id, title: "It’s a Mix" }, select: { body: true } })
    expect(mixNote?.body).toBe("Orbit and Nebula both waved. Say hi in the Mix.")
    // Orbit's pin is answered.
    expect((await cardsFor(w.orbit.people[1], w.eventId)).find((c) => c.crewId === w.nebula.crewId)).toMatchObject({ youWaved: true })
  })

  it("a like stays secret; a wave answers it with the one Mix; a wave over your own like tells them once", async () => {
    const w = await world("like")
    // An installed build's like: nobody on Orbit's side learns of it.
    await api.likeCrew(w.nebula.people[0], w.eventId, w.orbit.crewId, w.nebula.crewId)
    expect((await cardsFor(w.orbit.people[0], w.eventId)).find((c) => c.crewId === w.nebula.crewId)).toMatchObject({ wavedAtYou: false })
    expect((await lines(w.orbit.roomId)).some((l) => l.user_id === SYSTEM_USER_ID)).toBe(false)

    // Comet waves at Orbit over its own earlier like: told now, once.
    await api.likeCrew(w.comet.people[0], w.eventId, w.orbit.crewId, w.comet.crewId)
    await api.waveCrew(w.comet.people[1], w.eventId, w.orbit.crewId, w.comet.crewId)
    await api.waveCrew(w.comet.people[0], w.eventId, w.orbit.crewId, w.comet.crewId)
    expect((await lines(w.orbit.roomId)).filter((l) => l.content === "Comet waved at your crew")).toHaveLength(1)
    expect(await db.crew_likes.count({ where: { from_crew_id: w.comet.crewId, to_crew_id: w.orbit.crewId } })).toBe(1)

    // Orbit waves at Nebula, whose like was secret: the one Mix, its push says nothing of who waved, and no "waved at your crew" line.
    const mixed = await api.waveCrew(w.orbit.people[1], w.eventId, w.nebula.crewId, w.orbit.crewId)
    expect(mixed.body.data.blend).not.toBeNull()
    expect(await db.blends.count({ where: { occurrence_id: w.occurrenceId } })).toBe(1)
    const note = await db.notifications.findFirst({ where: { user_id: w.nebula.people[1].id, title: "It’s a Mix" }, select: { body: true } })
    expect(note?.body).toBe("Your crew and another matched tonight. Say hi in the Mix.")
    expect((await lines(w.nebula.roomId)).some((l) => l.content === "Orbit waved at your crew")).toBe(false)

    // A wave over Orbit's side once the Mix exists tells nothing new either.
    await api.likeCrew(w.comet.people[0], w.eventId, w.nebula.crewId, w.comet.crewId)
    await api.likeCrew(w.nebula.people[0], w.eventId, w.comet.crewId, w.nebula.crewId)
    await api.waveCrew(w.comet.people[1], w.eventId, w.nebula.crewId, w.comet.crewId)
    expect((await lines(w.nebula.roomId)).some((l) => l.content === "Comet waved at your crew")).toBe(false)
  })

  it("a person's wave at a crew names them by pseudonym only, and the crew's Wave back is the person-as-crew like", async () => {
    const w = await world("solo")
    await db.crews.update({ where: { id: w.orbit.crewId }, data: { open_to_solo: true, intent: ["friendship"] } })
    const solo = await person("solo-meera", "Meera Iyer")
    await arrive(w.eventId, w.occurrenceId, solo, "Lunar Fox")
    await api.prefs(solo, w.eventId, { openToCrews: true })

    const res = await api.waveCrew(solo, w.eventId, w.orbit.crewId)
    expect(res.body.data).toEqual({ liked: true, waved: true, blend: null })
    const handle = roomHandle(w.eventId, solo.id)
    const line = (await lines(w.orbit.roomId)).find((l) => l.metadata && (l.metadata as Record<string, unknown>).fromUserId)
    expect(line).toEqual({ user_id: SYSTEM_USER_ID, content: "Lunar Fox waved at the crew", metadata: { kind: "crew_waved", eventId: w.eventId, occurrenceId: w.occurrenceId, fromUserId: handle } })
    expect(JSON.stringify(line)).not.toContain("Meera")
    expect(JSON.stringify(line)).not.toContain(solo.id)

    const back = await api.likePerson(w.orbit.people[0], w.eventId, handle, w.orbit.crewId)
    expect(back.body.data.blend).not.toBeNull()
  })
})

it("a wave across a block between the sides is the 404 of a crew not there, and stores and tells nothing", async () => {
  const w = await world("block")
  await api.block(w.orbit.people[1], w.nebula.people[1].id)
  const res = await api.waveCrew(w.nebula.people[0], w.eventId, w.orbit.crewId, w.nebula.crewId)
  const nowhere = await api.waveCrew(w.nebula.people[0], w.eventId, "00000000-0000-4000-8000-000000000000", w.nebula.crewId)
  expect(res).toEqual(nowhere)
  expect(await db.crew_likes.count({ where: { from_crew_id: w.nebula.crewId } })).toBe(0)
  expect(await db.chat_messages.count({ where: { chat_group_id: w.orbit.roomId, user_id: SYSTEM_USER_ID } })).toBe(0)
  // Control: the unblocked pair waves.
  expect((await api.waveCrew(w.nebula.people[0], w.eventId, w.comet.crewId, w.nebula.crewId)).status).toBe(200)
})

describe("Block on a crew: hide it from you for good", () => {
  it("drops it from the hider's cards and refuses their wave as a crew not there; crewmates still see it; undone from Settings", async () => {
    const w = await world("hide")
    const hider = w.nebula.people[0]
    expect((await api.hide(hider, w.orbit.crewId)).body.data).toEqual({ hidden: true })
    expect((await api.hide(hider, w.orbit.crewId)).status).toBe(200)

    expect((await cardsFor(hider, w.eventId)).map((c) => c.crewId)).not.toContain(w.orbit.crewId)
    expect((await cardsFor(w.nebula.people[1], w.eventId)).map((c) => c.crewId)).toContain(w.orbit.crewId)
    const refused = await api.waveCrew(hider, w.eventId, w.orbit.crewId, w.nebula.crewId)
    const nowhere = await api.waveCrew(hider, w.eventId, "00000000-0000-4000-8000-000000000000", w.nebula.crewId)
    expect(refused).toEqual(nowhere)
    expect(refused.status).toBe(404)
    // Orbit is told nothing.
    expect(await db.chat_messages.count({ where: { chat_group_id: w.orbit.roomId, user_id: SYSTEM_USER_ID } })).toBe(0)

    const list = (await api.hidden(hider)).body.data
    expect(list.crews).toEqual([{ crewId: w.orbit.crewId, name: "Orbit", emblemSeed: expect.any(String), hiddenAt: expect.any(String) }])
    expect(list.pagination).toMatchObject({ totalCount: 1 })
    expect((await api.hidden(w.nebula.people[1])).body.data.crews).toEqual([])

    expect((await api.hide(hider, w.orbit.crewId, "DELETE")).body.data).toEqual({ hidden: false })
    expect((await cardsFor(hider, w.eventId)).map((c) => c.crewId)).toContain(w.orbit.crewId)
  })

  it("never confirms or names a crew with somebody kept apart from you", async () => {
    const w = await world("hide3")
    const outsider = w.comet.people[0]
    expect((await api.hide(outsider, w.orbit.crewId)).status).toBe(200)
    await api.block(w.orbit.people[1], outsider.id)
    // Listed no longer, and a fresh hide is the 404 of a crew not there.
    expect((await api.hidden(outsider)).body.data.crews).toEqual([])
    const fresh = await person("hide3-fresh")
    await api.block(fresh, w.nebula.people[0].id)
    const refused = await api.hide(fresh, w.nebula.crewId)
    expect(refused).toEqual(await api.hide(fresh, "00000000-0000-4000-8000-000000000000"))
    // Control: an unrelated crew still hides.
    expect((await api.hide(fresh, w.orbit.crewId)).status).toBe(200)
  })

  it("is not for your own crew, or a crew that is not there", async () => {
    const w = await world("hide2")
    expect((await api.hide(w.nebula.people[1], w.nebula.crewId)).status).toBe(404)
    expect((await api.hide(w.nebula.people[1], "00000000-0000-4000-8000-000000000000")).status).toBe(404)
    expect(await db.crew_hides.count({ where: { user_id: w.nebula.people[1].id } })).toBe(0)
  })
})

describe("a crew_waved line, per reader (SCRUM-1110)", () => {
  it("reaches the room's sockets with the metadata its history has", async () => {
    const w = await world("sock")
    const a = await sockets.online(w.orbit.people[0])
    expect(await sockets.joins(a, w.orbit.roomId)).toBe(true)
    await api.waveCrew(w.nebula.people[0], w.eventId, w.orbit.crewId, w.nebula.crewId)
    expect(await until(() => a.heard.message.length > 0)).toBe(true)
    const [line] = await wavedLines(w.orbit.people[0], w.orbit.roomId)
    expect(a.heard.message[0].message).toMatchObject({ content: "Nebula waved at your crew", metadata: line.metadata })
    expect(line.metadata).toEqual({ kind: "crew_waved", eventId: w.eventId, occurrenceId: w.occurrenceId, fromCrewId: w.nebula.crewId })
    // A person's words carry none.
    await api.send(w.orbit.people[1], w.orbit.roomId, "hello all")
    expect(await until(() => a.heard.message.length > 1)).toBe(true)
    expect(a.heard.message[1].message).not.toHaveProperty("metadata")
  })

  it("says `answered` once this crew waved or liked back, and only on the waves it answered", async () => {
    const w = await world("answered")
    // By id, so the answering crew is side B of one Mix and side A of the other.
    const [lo, mid, hi] = [w.nebula, w.orbit, w.comet].sort((a, b) => (a.crewId < b.crewId ? -1 : 1))
    const reader = mid.people[1]
    await api.waveCrew(lo.people[0], w.eventId, mid.crewId, lo.crewId)
    await api.waveCrew(hi.people[0], w.eventId, mid.crewId, hi.crewId)
    expect((await wavedLines(reader, mid.roomId)).map((l) => l.answered)).toEqual([false, false])

    await api.waveCrew(mid.people[0], w.eventId, lo.crewId, mid.crewId)
    const of = async (crewId: string) => (await wavedLines(reader, mid.roomId)).find((l) => l.metadata?.fromCrewId === crewId)?.answered
    expect(await of(lo.crewId)).toBe(true)
    expect(await of(hi.crewId)).toBe(false)
    // An installed build's like answers it too.
    await api.likeCrew(mid.people[0], w.eventId, hi.crewId, mid.crewId)
    expect(await of(hi.crewId)).toBe(true)
    // Still answered once the Mix is over, and a line from before `occurrenceId` was written is read by its event.
    await db.blends.updateMany({ where: { occurrence_id: w.occurrenceId }, data: { closed_at: new Date() } })
    await db.$executeRaw`UPDATE chat_messages SET metadata = metadata - 'occurrenceId' WHERE chat_group_id = ${mid.roomId}::uuid AND metadata ->> 'kind' = 'crew_waved'`
    expect(await of(lo.crewId)).toBe(true)
    // No other line carries the field.
    const all = (await api.read(reader, mid.roomId)).body.data.messages as Record<string, unknown>[]
    expect(all.filter((m) => "answered" in m)).toHaveLength(2)
  })

  it("a wave from another night stays unanswered by this night's Mix", async () => {
    const w = await world("night")
    await api.waveCrew(w.nebula.people[0], w.eventId, w.orbit.crewId, w.nebula.crewId)
    await db.$executeRaw`UPDATE chat_messages SET metadata = jsonb_set(metadata, '{occurrenceId}', '"00000000-0000-4000-8000-000000000000"') WHERE chat_group_id = ${w.orbit.roomId}::uuid AND metadata ->> 'kind' = 'crew_waved'`
    await api.waveCrew(w.orbit.people[0], w.eventId, w.nebula.crewId, w.orbit.crewId)
    expect((await wavedLines(w.orbit.people[1], w.orbit.roomId)).map((l) => l.answered)).toEqual([false])
  })

  it("a person's wave is answered by the crew's like of that person, not of another", async () => {
    const w = await world("solo-answered")
    await db.crews.update({ where: { id: w.orbit.crewId }, data: { open_to_solo: true, intent: ["friendship"] } })
    const [meera, kabir] = [await person("ans-meera", "Meera Iyer"), await person("ans-kabir", "Kabir Das")]
    for (const p of [meera, kabir]) {
      await arrive(w.eventId, w.occurrenceId, p)
      await api.prefs(p, w.eventId, { openToCrews: true })
      await api.waveCrew(p, w.eventId, w.orbit.crewId)
    }
    const handle = roomHandle(w.eventId, meera.id)
    expect((await api.likePerson(w.orbit.people[0], w.eventId, handle, w.orbit.crewId)).body.data.blend).not.toBeNull()
    const read = await wavedLines(w.orbit.people[1], w.orbit.roomId)
    expect(read.map((l) => [l.metadata?.fromUserId, l.answered])).toEqual([
      [handle, true],
      [roomHandle(w.eventId, kabir.id), false],
    ])
  })

  it("a crew you hid is out of your history, quotes, chat list and socket; your crewmates and every other line keep it", async () => {
    const w = await world("hidden")
    const [hider, mate] = w.orbit.people
    const [a, b] = [await sockets.online(hider), await sockets.online(mate)]
    expect(await sockets.joins(a, w.orbit.roomId)).toBe(true)
    expect(await sockets.joins(b, w.orbit.roomId)).toBe(true)
    await api.send(mate, w.orbit.roomId, "before the waves")
    await api.read(hider, w.orbit.roomId)
    await db.crews.update({ where: { id: w.orbit.crewId }, data: { open_to_solo: true, intent: ["friendship"] } })
    const solo = await person("hidden-solo", "Meera Iyer")
    await arrive(w.eventId, w.occurrenceId, solo)
    await api.prefs(solo, w.eventId, { openToCrews: true })

    // A person's wave (no fromCrewId) is not a hidden crew's.
    await api.waveCrew(solo, w.eventId, w.orbit.crewId)
    await api.hide(hider, w.nebula.crewId)
    // Hiding one crew hides no other: the mate, who hid Comet, hears Nebula.
    await api.hide(mate, w.comet.crewId)
    await api.waveCrew(w.nebula.people[0], w.eventId, w.orbit.crewId, w.nebula.crewId)
    expect(await until(() => b.heard.message.some((m) => m.message.content === "Nebula waved at your crew"))).toBe(true)
    // A marker after it: when the hider has heard this, the wave was not merely late.
    await api.send(mate, w.orbit.roomId, "marker line")
    expect(await until(() => a.heard.message.some((m) => m.message.content === "marker line"))).toBe(true)
    expect(a.heard.message.map((m) => m.message.content)).not.toContain("Nebula waved at your crew")

    const nebulaLine = (await wavedLines(mate, w.orbit.roomId)).find((l) => l.metadata?.fromCrewId === w.nebula.crewId)!
    expect(nebulaLine.content).toBe("Nebula waved at your crew")
    expect((await roomRow(hider, w.orbit.roomId))?.unreadCount).toBe(2) // the person's wave and the marker
    const mine = await wavedLines(hider, w.orbit.roomId)
    expect(mine.map((l) => Object.keys(l.metadata!).includes("fromUserId"))).toEqual([true])

    // Quoted by a crewmate: the hider reads the reply, not the line.
    await api.reply(mate, w.orbit.roomId, nebulaLine.id, "shall we wave back")
    const quoted = ((await api.read(hider, w.orbit.roomId)).body.data.messages as { content: string; parent_message: Record<string, unknown> | null }[]).find(
      (m) => m.content === "shall we wave back"
    )
    expect(quoted?.parent_message).toMatchObject({ content: null, metadata: null, moderation_hidden: true })

    // The newest line from a hidden crew is never the row's preview; with nothing read, it is not counted.
    await db.chat_messages.update({ where: { id: nebulaLine.id }, data: { created_at: new Date(Date.now() + 60_000) } })
    expect((await roomRow(hider, w.orbit.roomId))?.lastMessage?.content).toBe("shall we wave back")
    expect((await roomRow(mate, w.orbit.roomId))?.lastMessage?.content).toBe("Nebula waved at your crew")
    await db.chat_group_members.updateMany({ where: { chat_group_id: w.orbit.roomId }, data: { last_read_message_id: null } })
    const unreadBefore = (await roomRow(hider, w.orbit.roomId))!.unreadCount
    await api.hide(hider, w.nebula.crewId, "DELETE")
    expect((await roomRow(hider, w.orbit.roomId))!.unreadCount).toBe(unreadBefore + 1)
    expect((await wavedLines(hider, w.orbit.roomId)).some((l) => l.metadata?.fromCrewId === w.nebula.crewId)).toBe(true)
  })

  it("refuses a wave from outside the room in wave words", async () => {
    const w = await world("words")
    const outside = await person("words-out")
    expect((await api.waveCrew(outside, w.eventId, w.orbit.crewId)).body.error).toBe("Check in before you wave here.")
    expect((await api.likePerson(outside, w.eventId, roomHandle(w.eventId, w.orbit.people[0].id))).body.error).toBe("Check in before you wave here.")
    const solo = await person("words-solo")
    await arrive(w.eventId, w.occurrenceId, solo)
    expect((await api.waveCrew(solo, w.eventId, w.orbit.crewId)).body.error).toBe('Turn on "Open to joining a crew tonight" to wave at a crew.')
  })
})
