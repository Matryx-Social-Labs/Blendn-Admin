process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { api, arrive, befriend, cleanupCrewWorld, liveEvent, person } from "./crew-world"
import { db } from "./helpers"
import { sqlCounter, waveCounter } from "./sql-count"

/**
 * GET /events/:id/checkins, the room roster (perf/hot-paths #5).
 *
 * Its pseudonym read named every member of the room to label one page, its
 * independent reads ran one after another, and it reverse-geocoded every
 * coordinate-shaped profile location with no budget. The snapshot was taken
 * BEFORE the change over a room with a friend, a blocked person, a "show
 * online" off, a revealed person and plain ones: it must not change.
 */
const counter = sqlCounter()
afterAll(async () => {
  await counter.stop()
  await cleanupCrewWorld()
})

// Distinct per world: a resolved coordinate is cached for the life of the process.
const coordinatesFor = (n: number, base: number) => Array.from({ length: n }, (_, i) => `${base + i}.5,${70 + i}.25`)

async function world(coordinates: string[]) {
  const viewer = await person("rs-viewer", "Vee Viewer Rao")
  const host = await person("rs-host")
  const { eventId, occurrenceId } = await liveEvent(host.id)
  await arrive(eventId, occurrenceId, viewer, "Otter Viewer")
  await db.user.update({ where: { id: viewer.id }, data: { name: "Name viewer" } }) // listed to themselves, by name
  const now = Date.now()
  const cast = ["friend", "blocked", "offline", "revealed", "plain-1", "plain-2", "plain-3", "plain-4", "plain-5", "plain-6"]
  const label = new Map<string, string>()
  for (const [i, l] of cast.entries()) {
    const p = await person(`rs-${l}`, `Name ${l}`)
    label.set(p.id, l)
    await arrive(eventId, occurrenceId, p, `Pseudo ${l}`)
    await db.event_check_ins.updateMany({ where: { event_id: eventId, user_id: p.id }, data: { check_in_time: new Date(now - i * 60_000) } })
    await db.user.update({ where: { id: p.id }, data: { name: `Name ${l}` } })
    await db.profiles.update({
      where: { id: p.id },
      data: {
        photos: [`https://img.invalid/${l}.jpg`],
        location: l.startsWith("plain") ? coordinates[Number(l.slice(6)) - 1] ?? "Pune" : "Bengaluru",
        ...(l === "offline" && { show_online: false }),
      },
    })
    if (l === "revealed") await db.event_match_preferences.create({ data: { event_id: eventId, user_id: p.id, revealed: true } })
    if (l === "friend") await befriend(viewer, p)
    if (l === "blocked") await db.blocked_users.create({ data: { blocker_id: viewer.id, blocked_id: p.id } })
  }
  return { viewer, eventId, label }
}

describe("the room roster", () => {
  it("is what the snapshot says, names a page, and budgets its geocoding", async () => {
    const { viewer, eventId, label } = await world(coordinatesFor(3, 10))
    // `ageFrom` is clock-relative only through the birth date; these have a fixed age.
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ address: { city: "Testville" } })))
    try {
      const { result: res, sql } = await counter.during(() => api.checkins(viewer, eventId))
      expect(res.status).toBe(200)
      const rows = res.body.data.attendees.map((a: { userId: string; checkInTime: string }) => {
        const { userId, checkInTime, ...rest } = a
        void userId
        void checkInTime
        return rest
      })
      expect(rows).toMatchSnapshot()
      expect(res.body.data.pagination.totalCount).toBe(8) // not the viewer's friend or blocked, not "offline"
      expect(label.size).toBe(10)

      expect(fetchSpy.mock.calls.length).toBe(3) // within the budget: all resolved, as before

      // Before: every member of the room; after: the page's ids.
      const pseudonymRead = sql.find((q) => /FROM "public"\."chat_group_members"/.test(q) && /"anonymous_name"/.test(q))!
      expect(pseudonymRead).toMatch(/"user_id"\s+IN/)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("reverse-geocodes at most a budget's worth of coordinates per request", async () => {
    const { viewer, eventId } = await world(coordinatesFor(6, 40))
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ address: { city: "Testville" } })))
    try {
      const res = await api.checkins(viewer, eventId)
      expect(res.status).toBe(200)
      // Before: six parallel Nominatim calls on a user-facing read (a 1 req/s courtesy limit).
      expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(3)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("waits on the database in few waves", async () => {
    const { viewer, eventId } = await world(coordinatesFor(0, 0))
    const lagged = waveCounter(40)
    try {
      const { result: res, waves } = await lagged.during(() => api.checkins(viewer, eventId))
      expect(res.status).toBe(200)
      // 8 before: event, ban, attended, blocks, friends, count, page, names.
      expect(waves).toBeLessThanOrEqual(4)
    } finally {
      await lagged.stop()
    }
  })
})
