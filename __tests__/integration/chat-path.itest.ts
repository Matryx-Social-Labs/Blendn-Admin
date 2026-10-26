process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { db } from "./helpers"
import { api, arrive, cleanupCrewWorld, crewOf, liveEvent, person } from "./crew-world"
import { sqlCounter } from "./sql-count"

/**
 * The chat path's cost, in SQL statements (perf/chat-path). Ceilings with
 * headroom rather than exact figures: they catch a return to "every room read
 * selects every kind's door", which made an event room's history read 40
 * statements (34 of them the three owners' doors under a null parent).
 */
const counter = sqlCounter()
afterAll(async () => {
  await counter.stop()
  await cleanupCrewWorld()
})

describe("a room read costs the statements its kind needs", () => {
  it("reads an event room's history without selecting any owner's door", async () => {
    const host = await person("cp-host")
    const a = await person("cp-a")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    await arrive(eventId, occurrenceId, a)
    const room = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })
    await api.read(a, room.id) // warm
    const { result, sql } = await counter.during(() => api.read(a, room.id))
    expect(result.status).toBe(200)
    expect(sql.length).toBeLessThanOrEqual(12) // 40 before (10 after)
    expect(sql.some((q) => /"public"\."(crews|blends|board_posts)"/.test(q))).toBe(false)
  })

  it("reads a crew room's history with the crew's door and no other", async () => {
    const owner = await person("cp-o")
    const m = await person("cp-m")
    const { roomId } = await crewOf(owner, [m])
    const { result, sql } = await counter.during(() => api.read(m, roomId))
    expect(result.status).toBe(200)
    expect(sql.some((q) => /"public"\."crews"/.test(q))).toBe(true)
    expect(sql.some((q) => /"public"\."(blends|board_posts)"/.test(q))).toBe(false)
  })

  it("still refuses a person with a member row the crew does not admit", async () => {
    const owner = await person("cp-o2")
    const m = await person("cp-m2")
    const outsider = await person("cp-x")
    const { roomId } = await crewOf(owner, [m])
    await db.chat_group_members.create({ data: { chat_group_id: roomId, user_id: outsider.id, anonymous_name: "x" } })
    // A member row alone is never enough for a room that is not an event's.
    expect((await api.read(outsider, roomId)).status).toBe(403)
    expect((await api.send(outsider, roomId)).status).toBe(403)
    expect((await api.roster(outsider, roomId)).status).toBe(403)
    expect((await api.read(m, roomId)).status).toBe(200)
  })
})
