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

const coordinatesFor = (n: number, base: number) => Array.from({ length: n }, (_, i) => `${base + i}.5,${70 + i}.25`)

async function world(coordinates: string[], revealedLocation = "Bengaluru") {
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
        location: l.startsWith("plain") ? coordinates[Number(l.slice(6)) - 1] ?? "Pune" : l === "revealed" ? revealedLocation : "Bengaluru",
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
  it("is what the snapshot says, names a page, and geocodes nothing", async () => {
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

      // No read geocodes (SCRUM-1229), and beside a pseudonym no city is sent at all (D-030).
      expect(fetchSpy).not.toHaveBeenCalled()

      // Before: every member of the room; after: the page's ids.
      const pseudonymRead = sql.find((q) => /FROM "public"\."chat_group_members"/.test(q) && /"anonymous_name"/.test(q))!
      expect(pseudonymRead).toMatch(/"user_id"\s+IN/)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("reverse-geocodes nothing: coordinates read as no city (SCRUM-1229)", async () => {
    const { viewer, eventId } = await world(coordinatesFor(6, 40), "12.5,77.25")
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ address: { city: "Testville" } })))
    try {
      const res = await api.checkins(viewer, eventId)
      expect(res.status).toBe(200)
      // Six parallel Nominatim calls on a user-facing read once (a 1 req/s courtesy limit), then three; now none.
      expect(fetchSpy).not.toHaveBeenCalled()
      // The six coordinate rows sit beside a pseudonym, so D-030 sends them no city at all.
      const locations = res.body.data.attendees.map((a: { location: string | null }) => a.location)
      expect(locations.filter((l: string | null) => l === null).length).toBeGreaterThanOrEqual(6)
      // The revealed row is shown by name, so it does carry a city: its coordinates read as none (storedCity).
      const revealed = res.body.data.attendees.find((a: { image?: string }) => a.image === "https://img.invalid/revealed.jpg")
      expect(revealed).toBeDefined()
      expect(revealed.location).toBeNull()
      expect(JSON.stringify(res.body)).not.toMatch(/\d+\.5,\d+\.25/)
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
