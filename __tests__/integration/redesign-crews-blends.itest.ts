/*
 * The server changes the client redesign needs for crews and Blends, on a
 * migrate-deploy database: what a crew and its invites say (`hidden`, `apart`,
 * `invitedByPhoto`), what a Blend says for the reveal sheet (`roomSize`,
 * `crewRevealed`, the toast counts), the refusal naming its field, and
 * reporting a person in a crew's or Blend's room by handle.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-redesign-secret-of-32-characters-x"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { resetMemoryStore } from "@/lib/rate-limit-store"
import { db } from "./helpers"
import { api, arrive, befriend, call, cleanupCrewWorld, crewOf, liveEvent, person, routes, socketHarness, type Person } from "./crew-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const reportMember = require("@/app/api/mobile/chat/groups/[chatGroupId]/members/[userId]/report/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/members/[userId]/report/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const sockets = socketHarness()
beforeAll(() => sockets.start())
beforeEach(() => resetMemoryStore())
afterAll(async () => {
  await sockets.stop()
  await cleanupCrewWorld()
})

async function blended(label: string) {
  const host = await person(`${label}-host`)
  const { eventId, occurrenceId } = await liveEvent(host.id)
  const a = await Promise.all(["a1", "a2", "a3"].map((l) => person(`${label}-${l}`, `Ananya ${l} Bhat`)))
  const b = await Promise.all(["b1", "b2", "b3"].map((l) => person(`${label}-${l}`, `Vikram ${l} Shetty`)))
  const A = await crewOf(a[0], [a[1], a[2]], "Crew Two")
  const B = await crewOf(b[0], [b[1], b[2]], "Crew Five")
  for (const p of [a[0], a[1], b[0], b[1]]) await arrive(eventId, occurrenceId, p)
  await api.likeCrew(a[0], eventId, B.crewId, A.crewId)
  const back = await api.likeCrew(b[0], eventId, A.crewId, B.crewId)
  return { eventId, A, B, a, b, roomId: back.body.data.blend.chatGroupId as string, blendId: back.body.data.blend.blendId as string }
}

const blendOf = async (viewer: Person, blendId: string) =>
  (await api.blends(viewer)).body.data.blends.find((x: { blendId: string }) => x.blendId === blendId)
const side = (blend: { sides: { mine: boolean }[] }, mine: boolean) => blend.sides.find((s) => s.mine === mine) as Record<string, unknown>

describe("a crew and its invites", () => {
  it("says it is hidden when a moderator hid it, and nothing else about why", async () => {
    const owner = await person("hid-o")
    const friend = await person("hid-f")
    const C = await crewOf(owner, [friend], "Hidden Soon")
    expect((await api.detail(friend, C.crewId)).body.data.hidden).toBe(false)
    await db.crews.update({ where: { id: C.crewId }, data: { hidden_at: new Date() } })
    expect((await api.detail(friend, C.crewId)).body.data.hidden).toBe(true)
  })

  it("`apart` is true only for a crewmate YOU blocked: their block of you, or a closed chat, says nothing", async () => {
    const owner = await person("ap-o")
    const [m1, m2, m3] = await Promise.all(["ap-1", "ap-2", "ap-3"].map((l) => person(l)))
    const C = await crewOf(owner, [m1, m2, m3], "Some Apart")
    const apart = async (p: Person) => (await api.detail(p, C.crewId)).body.data
    expect((await apart(owner)).apart).toBe(false)
    // m1 blocks m2: m1 is told (they did it), m2 sees one fewer and is NOT told why.
    await db.blocked_users.create({ data: { blocker_id: m1.id, blocked_id: m2.id } })
    const seenByBlocker = await apart(m1)
    const seenByBlocked = await apart(m2)
    expect(seenByBlocker).toMatchObject({ apart: true, size: 3 })
    expect(seenByBlocked).toMatchObject({ apart: false, size: 3 })
    // The blocked one's list is shorter than the crew, and still carries no flag that says so.
    expect((await apart(owner)).apart).toBe(false)
  })

  it("`invitedByPhoto` is the inviter's first photo, for exactly the invites whose sender's name is shown", async () => {
    const owner = await person("ph-o", "Zara Photo Khan")
    const guest = await person("ph-g")
    await befriend(owner, guest)
    await db.profiles.update({ where: { id: owner.id }, data: { photos: ["https://img.invalid/first.jpg", "https://img.invalid/second.jpg"] } })
    const made = await api.create(owner, { name: "Photo Crew", inviteUserIds: [guest.id] })
    expect(made.status).toBe(201)
    const listed = () => call(routes.crews.GET, "/api/mobile/crews", guest)
    const invite = (await listed()).body.data.invites[0]
    expect(invite).toMatchObject({ invitedBy: "Zara", invitedByPhoto: "https://img.invalid/first.jpg" })
    // No photo: null, not a missing key.
    await db.profiles.update({ where: { id: owner.id }, data: { photos: [] } })
    expect((await listed()).body.data.invites[0].invitedByPhoto).toBeNull()
    // Not friends any more: the invite is not shown, so neither is the face.
    await db.friendships.deleteMany({ where: { OR: [{ user1_id: owner.id }, { user2_id: owner.id }] } })
    expect((await listed()).body.data.invites).toHaveLength(0)
  })

  it("a refused crew name or bio says which field it was", async () => {
    const owner = await person("fld-o")
    const refused = await api.create(owner, { name: "Ring 9876543210" })
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ field: "name", errors: [{ field: "name" }] })
    const bio = await api.create(owner, { name: "Fine Name", bio: "mail me a@b.com" })
    expect(bio.body.field).toBe("bio")
  })
})

describe("a Blend, for the reveal sheet", () => {
  it("`roomSize` counts the people a reveal reaches, show-online-off included, kept-apart out", async () => {
    const w = await blended("room")
    const [a1, a2] = w.a
    const [b1, b2] = w.b
    expect((await blendOf(a1, w.blendId)).roomSize).toBe(4)
    // a2 turns "show online" off: gone from every side's count, still in the room that sees the faces.
    await db.profiles.update({ where: { id: a2.id }, data: { show_online: false } })
    const seen = await blendOf(b1, w.blendId)
    expect(seen.roomSize).toBe(4)
    expect(side(seen, false).count).toBe(1)
    expect(side(seen, true).count).toBe(2)
    // b1 blocks b2: a pair kept apart is not counted to b1 (their own `size` rule), still is to a1.
    await db.blocked_users.create({ data: { blocker_id: b1.id, blocked_id: b2.id } })
    expect((await blendOf(b1, w.blendId)).roomSize).toBe(3)
    expect((await blendOf(a1, w.blendId)).roomSize).toBe(4)
  })

  it("`crewRevealed` is a bit about your own crew; the toast counts stay on their side only", async () => {
    const w = await blended("bit")
    const [a1, a2] = w.a
    const [b1] = w.b
    await api.settings(a2, w.A.crewId, true)
    const before = await blendOf(b1, w.blendId)
    expect(side(before, true)).toMatchObject({ crewRevealed: false, revealedCount: null, privateCount: null })
    expect(side(before, false)).toMatchObject({ crewRevealed: null, revealedCount: 0, privateCount: 1 })
    expect((await api.reveal(a1, w.blendId)).body.data).toEqual({ revealed: true })
    // Their crew sees one revealed and one private; yours is told only that it happened.
    const theirs = await blendOf(b1, w.blendId)
    expect(side(theirs, false)).toMatchObject({ revealedCount: 1, privateCount: 1, revealed: 1, keptPrivate: 1, crewRevealed: null })
    const mine = await blendOf(a2, w.blendId)
    expect(side(mine, true)).toMatchObject({ crewRevealed: true, revealedCount: null, privateCount: null })
    expect(side(mine, false).crewRevealed).toBeNull()
    expect(side(await blendOf(b1, w.blendId), true).crewRevealed).toBe(false)
  })
})

describe("reporting a person in a crew's or Blend's room by handle", () => {
  const report = (as: Person, groupId: string, handle: string, body: Record<string, unknown> = { reason: "harassment", description: "rude" }) =>
    call(reportMember.POST, `/api/mobile/chat/groups/${groupId}/members/${handle}/report`, as, {
      method: "POST",
      body,
      params: { chatGroupId: groupId, userId: handle },
    })

  it("files a user report from a Blend and from a crew, for members of that room only", async () => {
    const w = await blended("rep")
    const [a1, a2, a3] = w.a
    const [b1] = w.b
    const handleOfA1 = (await blendOf(b1, w.blendId)).sides.find((s: { mine: boolean }) => !s.mine).people.map((p: { userId: string }) => p.userId)
    expect(handleOfA1[0]).toMatch(/^rh_/)
    // Which handle is a1's: ask the reported one's row afterwards.
    const done = await report(b1, w.roomId, handleOfA1[0])
    expect(done).toMatchObject({ status: 201, body: { data: { reported: true } } })
    const row = await db.user_reports.findFirstOrThrow({ where: { reporter_id: b1.id } })
    expect([a1.id, a2.id]).toContain(row.reported_id)
    expect(row.description).toBe("In a Blend's room. rude")

    // A crew's room: a crewmate by the crew's handle.
    const crew = (await api.detail(a1, w.A.crewId)).body.data
    const mate = crew.members.find((m: { userId: string }) => m.userId !== a1.id)
    expect((await report(a1, crew.chatGroupId, mate.userId)).status).toBe(201)
    expect(await db.user_reports.count({ where: { reporter_id: a1.id } })).toBe(1)

    // Not a member of the Blend's room: the one 404, and nothing written.
    expect((await report(a3, w.roomId, handleOfA1[0])).status).toBe(404)
    expect(await db.user_reports.count({ where: { reporter_id: a3.id } })).toBe(0)
  })

  it("refuses yourself, another room's handle, a forged one and a room that is not a crew's or Blend's", async () => {
    const w = await blended("rep2")
    const [a1] = w.a
    const [b1] = w.b
    expect((await report(b1, w.roomId, b1.id)).status).toBe(400)
    const crew = (await api.detail(a1, w.A.crewId)).body.data
    const crewHandle = crew.members.find((m: { userId: string }) => m.userId !== a1.id).userId
    // A crew handle names nobody in the Blend's room, and a forged handle nobody anywhere.
    expect((await report(a1, w.roomId, crewHandle)).status).toBe(404)
    expect((await report(a1, w.roomId, "rh_" + "A".repeat(60))).status).toBe(404)
    const eventRoom = await db.chat_groups.findUniqueOrThrow({ where: { event_id: w.eventId }, select: { id: true } })
    expect((await report(a1, eventRoom.id, crewHandle)).status).toBe(404)
    expect(await db.user_reports.count({ where: { reporter_id: { in: [a1.id, b1.id] } } })).toBe(0)
  })

  it("is rate limited per person", async () => {
    const w = await blended("rep3")
    const [b1] = w.b
    const handle = (await blendOf(b1, w.blendId)).sides.find((s: { mine: boolean }) => !s.mine).people[0].userId
    const statuses: number[] = []
    for (let i = 0; i < 22; i++) statuses.push((await report(b1, w.roomId, handle)).status)
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true)
    expect(statuses.slice(20)).toEqual([429, 429])
  })
})
