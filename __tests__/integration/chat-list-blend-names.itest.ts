process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { api, arrive, cleanupCrewWorld, crewOf, liveEvent, person } from "./crew-world"
import { sqlCounter, waveCounter } from "./sql-count"

/**
 * The chat list names the last speaker in each Blend room (perf/hot-paths #14).
 * It did it one Blend at a time, three statements and a wait each; now one read
 * for the lot. The names are the speaker's pseudonym at the Blend's event.
 */
const counter = sqlCounter()
afterAll(async () => {
  await counter.stop()
  await cleanupCrewWorld()
})

const BLENDS = 3

async function world() {
  const viewer = await person("bn-viewer", "Vee Viewer Rao")
  const expected = new Map<string, string>()
  for (let k = 1; k <= BLENDS; k++) {
    const host = await person(`bn-host${k}`)
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const [a2, a3, b1, b2, b3] = await Promise.all(["a2", "a3", "b1", "b2", "b3"].map((l) => person(`bn-${k}-${l}`)))
    const A = await crewOf(viewer, [a2, a3], `Home ${k}`)
    const B = await crewOf(b1, [b2, b3], `Away ${k}`)
    for (const [i, p] of [viewer, a2, b1, b2].entries()) await arrive(eventId, occurrenceId, p, `Pseudo ${k} ${i === 2 ? "speaker" : i}`)
    expect((await api.likeCrew(a2, eventId, B.crewId, A.crewId)).status).toBe(200)
    const back = await api.likeCrew(b2, eventId, A.crewId, B.crewId)
    const room = back.body.data.blend.chatGroupId as string
    // The other side speaks last: its sender's pseudonym is the line's name.
    expect((await api.send(b1, room, `hello from ${k}`)).status).toBe(201)
    expected.set(room, `Pseudo ${k} speaker`)
  }
  return { viewer, expected }
}

describe("the chat list's Blend rooms", () => {
  it("name the last speaker by their pseudonym, with one read for all the Blends", async () => {
    const { viewer, expected } = await world()
    await api.chatGroups(viewer) // warm
    const { result: res, sql } = await counter.during(() => api.chatGroups(viewer))
    expect(res.status).toBe(200)
    const rooms = res.body.data.rooms.filter((r: { id: string }) => expected.has(r.id))
    expect(rooms).toHaveLength(BLENDS)
    for (const r of rooms) expect(r.lastMessage.user.name).toBe(expected.get(r.id))
    // Before: 4 for three Blends (one more per room), each after the last.
    expect(sql.filter((q) => /"anonymous_name"/.test(q) && /FROM "public"\."chat_group_members"/.test(q)).length).toBeLessThanOrEqual(2) // the last-message read, and one for the Blends
  })

  it("waits for them in the same wave, not one after another", async () => {
    const { viewer } = await world()
    const lagged = waveCounter(40)
    try {
      const { result, waves } = await lagged.during(() => api.chatGroups(viewer))
      expect(result.status).toBe(200)
      // Before: +2 waves per Blend room after the main wave.
      expect(waves).toBeLessThanOrEqual(3)
    } finally {
      await lagged.stop()
    }
  })
})
