/**
 * Crew invite links (crews 3-B, S7): any member makes a single-use, 7-day
 * link; a holder who is not the sharer's friend joins by it and becomes their
 * friend in the same transaction. Every way a link cannot be used is the one
 * 404 and spends nothing; a full crew is a 409 that spends nothing.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-crew-links-secret-of-32-characters-x"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { NextRequest } from "next/server"

import { CREW } from "@/lib/constants"
import { conversationPair } from "@/lib/conversations"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { GET as preview } from "@/app/api/mobile/crews/links/[token]/preview/route"

import { db, makeUser, testId } from "./helpers"
import { api, cleanupCrewWorld, crewOf, person, world as crewWorld, type Person } from "./crew-world"

beforeEach(() => resetMemoryStore())
afterAll(() => cleanupCrewWorld())

const UNKNOWN = "AAAAAAAAAAAAAAAAAAAAAA"
const friends = async (a: Person, b: Person) => {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  return (await db.friendships.count({ where: { user1_id, user2_id } })) === 1
}
const publicPreview = async (token: string) => {
  const res = await preview(new NextRequest(`http://localhost/api/mobile/crews/links/${token}/preview`), { params: Promise.resolve({ token }) })
  return { status: res.status, body: await res.json() }
}

async function crew(label: string) {
  const owner = await person(`${label}-own`, "Priya Shah")
  const mate = await person(`${label}-mate`, "Arjun Rao")
  const made = await crewOf(owner, [mate], "Nebula")
  return { owner, mate, ...made }
}

describe("A crew invite link", () => {
  it("brings in a stranger, makes them the sharer's friend, and is spent", async () => {
    const c = await crew("lk")
    const made = await api.makeLink(c.mate, c.crewId)
    expect(made.status).toBe(201)
    const { token, url, expiresAt } = made.body.data
    expect(url).toBe(`https://www.blendn.app/c/${token}`)
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(CREW.LINK_TTL_MS - 60_000)

    // Signed out: the crew and who shared it, nothing more.
    const pub = await publicPreview(token)
    expect(pub.body.data).toEqual({ name: "Nebula", emblemSeed: expect.any(String), size: 2, invitedBy: { name: "Arjun", photoUrl: null } })

    const asha = await person("lk-asha", "Asha Menon")
    const card = (await api.openLink(asha, token)).body.data
    expect(card).toMatchObject({ crewId: c.crewId, name: "Nebula", size: 2, invitedBy: { name: "Arjun" }, member: false, expiresAt })

    expect((await api.joinLink(asha, token, {})).status).toBe(400) // the reveal consent is required
    const joined = await api.joinLink(asha, token)
    expect(joined.body.data).toEqual({ crewId: c.crewId, chatGroupId: c.roomId })
    expect(await db.crew_members.count({ where: { crew_id: c.crewId, user_id: asha.id } })).toBe(1)
    expect(await friends(asha, c.mate)).toBe(true)
    expect(await friends(asha, c.owner)).toBe(false)
    expect(await db.crew_invite_tokens.findUnique({ where: { token }, select: { used_by: true } })).toEqual({ used_by: asha.id })

    // Spent: a second holder gets the 404 of a link that never existed.
    const late = await person("lk-late")
    const refused = await api.joinLink(late, token)
    expect(refused).toEqual(await api.joinLink(late, UNKNOWN))
    expect(refused.status).toBe(404)
    expect(refused.body).toMatchObject({ errorCode: "NOT_FOUND", reasonCode: "INVITE_UNAVAILABLE" })
    expect((await publicPreview(token)).status).toBe(404)
  })

  it("dies with its sharer's membership, or when the sharer or owner revokes it; nobody else may", async () => {
    const c = await crew("lkr")
    const third = await person("lkr-third")
    const a = (await api.makeLink(c.mate, c.crewId)).body.data.token
    const b = (await api.makeLink(c.mate, c.crewId)).body.data.token
    const holder = await person("lkr-holder")

    // A stranger to the crew cannot revoke; the link still opens.
    expect((await api.revokeLink(third, c.crewId, a)).status).toBe(404)
    expect((await api.openLink(holder, a)).status).toBe(200)
    // The owner can.
    expect((await api.revokeLink(c.owner, c.crewId, a)).body.data).toEqual({ revoked: true })
    expect((await api.openLink(holder, a)).status).toBe(404)

    // The sharer leaves (a third member keeps the crew standing): their other link is gone, with nothing written.
    const extra = await person("lkr-extra")
    await db.crew_members.create({ data: { crew_id: c.crewId, user_id: extra.id, consented_reveal_at: new Date() } })
    expect((await api.remove(c.mate, c.crewId, c.mate.id)).status).toBe(200)
    expect((await api.openLink(holder, b)).status).toBe(404)
    expect((await api.joinLink(holder, b)).status).toBe(404)
  })

  it("a holder kept apart from anybody in the crew is the 404 of no link, and spends nothing", async () => {
    const c = await crew("lkb")
    const token = (await api.makeLink(c.mate, c.crewId)).body.data.token
    const blocker = await person("lkb-blocker")
    await api.block(blocker, c.owner.id)
    const refused = await api.joinLink(blocker, token)
    expect(refused).toEqual(await api.joinLink(blocker, UNKNOWN))
    expect((await api.openLink(blocker, token)).status).toBe(404)
    expect(await db.crew_members.count({ where: { crew_id: c.crewId, user_id: blocker.id } })).toBe(0)
    // Control: the link is unspent, and works for somebody else.
    expect((await api.joinLink(await person("lkb-ok"), token)).status).toBe(200)
  })

  it("a full crew is a 409 and the link is not spent; a lapsed link is a 404", async () => {
    const c = await crew("lkf")
    const token = (await api.makeLink(c.owner, c.crewId)).body.data.token
    const fillers = await Promise.all(Array.from({ length: CREW.MAX_MEMBERS - 2 }, (_, i) => makeUser(testId(`lkf-fill${i}`))))
    crewWorld.users.push(...fillers)
    await db.crew_members.createMany({ data: fillers.map((id) => ({ crew_id: c.crewId, user_id: id, consented_reveal_at: new Date() })) })
    const holder = await person("lkf-holder")
    expect((await api.joinLink(holder, token)).status).toBe(409)
    expect(await db.crew_invite_tokens.findUnique({ where: { token }, select: { used_at: true } })).toEqual({ used_at: null })
    expect(await friends(holder, c.owner)).toBe(false)

    await db.crew_invite_tokens.update({ where: { token }, data: { created_at: new Date(Date.now() - CREW.LINK_TTL_MS - 1000) } })
    expect((await api.openLink(holder, token)).status).toBe(404)
  })

  it("is for members only, and at most LINKS_PER_WINDOW a day", async () => {
    const c = await crew("lkc")
    expect((await api.makeLink(await person("lkc-out"), c.crewId)).status).toBe(404)
    for (let i = 0; i < CREW.LINKS_PER_WINDOW; i++) expect((await api.makeLink(c.owner, c.crewId)).status).toBe(201)
    expect((await api.makeLink(c.owner, c.crewId)).status).toBe(429)
    // Control: another member's own day.
    expect((await api.makeLink(c.mate, c.crewId)).status).toBe(201)
  })
})
