process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefghij"

// `jose` is ESM-only; see checkin.itest.ts.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))

import { hereCountCoalesced, hereCountFor, hereCounts } from "@/lib/attendee-counts"

import { closeDb, db } from "./helpers"
import { cleanupWorld, goLive, person, venue } from "./go-live-world"

/**
 * The Room's headcount at a venue day is the people whose Go Live window is
 * open now (`inRoomWhere`), not whoever the sweeper has yet to reach
 * (SCRUM-922). The roster and the participants list already said so; the count
 * the sockets send as `hereCount` did not, so it ran ahead of the list by the
 * sweep lag.
 */

afterAll(async () => {
  await cleanupWorld()
  await closeDb()
}, 120_000)

describe("a venue day's here-count", () => {
  it("drops a person whose window has ended before the sweeper has reached them", async () => {
    const v = await venue()
    const people = [await person("vdh"), await person("vdh"), await person("vdh")]
    const results = await Promise.all(people.map((p) => goLive(p.token, v)))
    const dayId = results[0].json.data.venueDayId as string
    expect(await hereCountFor(dayId)).toBe(3)

    await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: people[2].id }, data: { expires_at: new Date(Date.now() - 1_000) } })
    expect((await db.event_check_ins.findFirstOrThrow({ where: { event_id: dayId, user_id: people[2].id } })).status).toBe("checked_in")

    expect(await hereCountFor(dayId)).toBe(2)
    expect(await hereCountCoalesced(dayId)).toBe(2)
    expect((await hereCounts([dayId])).get(dayId)).toBe(2)
  })
})
