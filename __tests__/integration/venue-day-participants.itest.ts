process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefghij"

// `jose` is ESM-only; see checkin.itest.ts.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))

import { closeDb, db } from "./helpers"
import { cleanupWorld, eventParams, goLive, groupParams, person, req, routes, venue } from "./go-live-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const participants = require("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * At a venue day the room's people are the ones whose Go Live window is open
 * now (`inRoomWhere`), whoever the sweeper has not yet reached (SCRUM-915). The
 * roster applied that; the room's participants list did not, so a person whose
 * window had ended but whose row was still `checked_in` stayed listed, and
 * since SCRUM-629 could be named, from a room they are no longer live in.
 */

afterAll(async () => {
  await cleanupWorld()
  await closeDb()
}, 120_000)

describe("a venue day's participants and roster agree on who is live", () => {
  it("leave out a person whose window has ended but who has not been swept", async () => {
    const v = await venue()
    const [me, stays, lapsed] = [await person("vdp"), await person("vdp"), await person("vdp")]
    const mine = await goLive(me.token, v)
    const { venueDayId, chatGroupId } = mine.json.data
    await goLive(stays.token, v)
    await goLive(lapsed.token, v)

    const listed = async () => {
      const res = await participants.GET(req(`/api/mobile/chat/groups/${chatGroupId}/participants`, me.token), groupParams(chatGroupId))
      expect(res.status).toBe(200)
      return (await res.json()).data as { participants: { name: string }[]; totalCount: number }
    }
    const rostered = async () => {
      const res = await routes.roster.GET(req(`/api/mobile/events/${venueDayId}/checkins`, me.token), eventParams(venueDayId))
      expect(res.status).toBe(200)
      return (await res.json()).data.pagination.totalCount as number
    }
    expect((await listed()).totalCount).toBe(3)
    expect(await rostered()).toBe(3)

    // The window ends; no sweeper has run, so the row is still `checked_in`.
    await db.event_check_ins.updateMany({ where: { event_id: venueDayId, user_id: lapsed.id }, data: { expires_at: new Date(Date.now() - 1_000) } })
    expect((await db.event_check_ins.findFirstOrThrow({ where: { event_id: venueDayId, user_id: lapsed.id } })).status).toBe("checked_in")

    const gone = (await db.chat_group_members.findUniqueOrThrow({ where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: lapsed.id } } })).anonymous_name
    const after = await listed()
    expect(after.totalCount).toBe(2)
    expect(after.participants.map((p) => p.name)).not.toContain(gone)
    expect(await rostered()).toBe(2)
  })
})
