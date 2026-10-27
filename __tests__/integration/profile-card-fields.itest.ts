/*
 * What the person card sends (the 2026-10-27 fix round): the interests you
 * share (SCRUM-858), no interest list for somebody you may not see (SCRUM-835),
 * and the count Me shows over the saved list it opens (SCRUM-825).
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-profile-card-secret-32-characters-xx"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { db, makeEvent, testId } from "./helpers"
import { befriend, call, cleanupCrewWorld, person, world } from "./crew-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const userRoute = require("@/app/api/mobile/users/[userId]/route") as typeof import("@/app/api/mobile/users/[userId]/route")
const favoritesRoute = require("@/app/api/mobile/users/[userId]/favorites/route") as typeof import("@/app/api/mobile/users/[userId]/favorites/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const slugs: string[] = []
afterAll(async () => {
  await db.event_favorites.deleteMany({ where: { user_id: { in: world.users } } })
  await db.user_interests.deleteMany({ where: { user_id: { in: world.users } } })
  await db.categories.deleteMany({ where: { slug: { in: slugs } } })
  await cleanupCrewWorld()
})

const card = (ref: string, as: Awaited<ReturnType<typeof person>>) => call(userRoute.GET, `/api/mobile/users/${ref}`, as, { params: { userId: ref } })

async function category(name: string) {
  const slug = testId("pcf")
  slugs.push(slug)
  return db.categories.create({ data: { name, slug } })
}

describe("sharedInterests and the interest list", () => {
  it("names the interests both picked, to somebody you may see; never to yourself", async () => {
    const [me, them] = [await person("pcf-me"), await person("pcf-them")]
    await befriend(me, them)
    const [jazz, pottery, chess] = [await category("Jazz"), await category("Pottery"), await category("Chess")]
    await db.user_interests.createMany({
      data: [
        { user_id: me.id, category_id: jazz.id },
        { user_id: me.id, category_id: chess.id },
        { user_id: them.id, category_id: jazz.id },
        { user_id: them.id, category_id: pottery.id },
      ],
    })
    const seen = (await card(them.id, me)).body.data
    expect(seen.sharedInterests).toEqual(["Jazz"])
    expect(seen.interests.map((i: { name: string }) => i.name).sort()).toEqual(["Jazz", "Pottery"])
    expect((await card(me.id, me)).body.data.sharedInterests).toBeUndefined()
  })

  it("is an empty list, key kept, for a stranger's card", async () => {
    const [me, stranger] = [await person("pcf-s1"), await person("pcf-s2")]
    const jazz = await category("Jazz2")
    await db.user_interests.createMany({
      data: [
        { user_id: me.id, category_id: jazz.id },
        { user_id: stranger.id, category_id: jazz.id },
      ],
    })
    const res = (await card(stranger.id, me)).body.data
    expect(res).toMatchObject({ identityVisible: false, interests: [] })
    expect(res.sharedInterests).toBeUndefined()
  })
})

describe("stats.savedCount", () => {
  it("counts what the saved list shows: upcoming, not deleted, not draft, not past", async () => {
    const [me, host] = [await person("pcf-sv"), await person("pcf-host")]
    const future = { start_time: new Date(Date.now() + 86_400_000), end_time: new Date(Date.now() + 90_000_000) }
    const shown = await makeEvent(host.id)
    const deleted = await makeEvent(host.id)
    const draft = await makeEvent(host.id)
    const past = await makeEvent(host.id)
    world.events.push(shown, deleted, draft, past)
    await db.events.update({ where: { id: shown }, data: future })
    await db.events.update({ where: { id: deleted }, data: { ...future, deleted_at: new Date() } })
    await db.events.update({ where: { id: draft }, data: { ...future, status: "draft" } })
    await db.events.update({ where: { id: past }, data: { start_time: new Date(Date.now() - 9e6), end_time: new Date(Date.now() - 8e6) } })
    await db.event_favorites.createMany({ data: [shown, deleted, draft, past].map((event_id) => ({ event_id, user_id: me.id })) })

    const listed = await call(favoritesRoute.GET, `/api/mobile/users/${me.id}/favorites`, me, { params: { userId: me.id } })
    const count = (await card(me.id, me)).body.data.stats.savedCount
    expect(count).toBe(1)
    expect(count).toBe(listed.body.data.pagination?.total ?? listed.body.data.events.length)
  })

  it("is not sent about somebody else", async () => {
    const [me, them] = [await person("pcf-o1"), await person("pcf-o2")]
    await befriend(me, them)
    expect((await card(them.id, me)).body.data.stats).not.toHaveProperty("savedCount")
  })
})
