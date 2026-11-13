/**
 * End the crew (crews NOTES §6 S6, owner 5A): the owner ends it for everyone.
 * What ends — the crew, its members and invites, its room (one last line,
 * then archived), its open Mixes — and what does not: friendships. No push.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-redesign-secret-of-32-characters-x"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { resetMemoryStore } from "@/lib/rate-limit-store"
import { db } from "./helpers"
import { api, arrive, befriend, call, cleanupCrewWorld, crewOf, liveEvent, person, routes, type Person } from "./crew-world"

beforeEach(() => resetMemoryStore())
afterAll(() => cleanupCrewWorld())

const end = (as: Person, crewId: string) => call(routes.crew.DELETE, `/api/mobile/crews/${crewId}`, as, { method: "DELETE", params: { crewId } })

describe("End the crew (S6)", () => {
  it("ends it for everyone: members, invites, room and open Mixes; friendships stay; nobody is pushed", async () => {
    const priya = await person("end-priya", "Priya Raman")
    const arjun = await person("end-arjun", "Arjun Mehta")
    const meera = await person("end-meera", "Meera Iyer")
    const invited = await person("end-invited", "Kabir Das")
    const { crewId, roomId } = await crewOf(priya, [arjun, meera], "Nebula")
    await befriend(priya, invited)
    expect((await api.invite(priya, crewId, [invited.id])).status).toBe(200)

    // An open Mix with another crew, to see it close.
    const host = await person("end-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const o1 = await person("end-o1")
    const o2 = await person("end-o2")
    const other = await crewOf(o1, [o2], "Orbit")
    for (const p of [priya, arjun, o1, o2]) await arrive(eventId, occurrenceId, p)
    await api.likeCrew(priya, eventId, other.crewId, crewId)
    const mixed = await api.likeCrew(o1, eventId, crewId, other.crewId)
    const blendId = mixed.body.data.blend.blendId as string
    const notesBefore = await db.notifications.count({ where: { user_id: { in: [arjun.id, meera.id, invited.id] } } })

    const res = await end(priya, crewId)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ ended: true })

    const crew = await db.crews.findUniqueOrThrow({ where: { id: crewId }, select: { dissolved_at: true } })
    expect(crew.dissolved_at).not.toBeNull()
    expect(await db.crew_members.count({ where: { crew_id: crewId } })).toBe(0)
    expect(await db.crew_invites.count({ where: { crew_id: crewId } })).toBe(0)
    const room = await db.chat_groups.findUniqueOrThrow({ where: { id: roomId }, select: { status: true } })
    expect(room.status).toBe("archived")
    expect(await db.chat_group_members.count({ where: { chat_group_id: roomId, status: { in: ["active", "muted"] } } })).toBe(0)
    const last = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: roomId }, orderBy: { created_at: "desc" }, select: { content: true, metadata: true } })
    expect(last).toEqual({ content: "Nebula has ended", metadata: { kind: "crew_ended" } })
    expect((await db.blends.findUniqueOrThrow({ where: { id: blendId }, select: { closed_at: true } })).closed_at).not.toBeNull()
    // Gone from every member's view; the invite is void.
    expect((await api.detail(arjun, crewId)).status).toBe(404)
    expect((await api.join(invited, crewId)).status).toBe(404)
    // Friendships stay. No push, to anybody.
    expect(await db.friendships.count({ where: { OR: [{ user1_id: priya.id }, { user2_id: priya.id }] } })).toBe(3)
    expect(await db.notifications.count({ where: { user_id: { in: [arjun.id, meera.id, invited.id] } } })).toBe(notesBefore)
    // It cannot be undone, or ended twice.
    expect((await end(priya, crewId)).status).toBe(404)
  })

  it("is the owner's alone: a member or a stranger gets the same 404, and the crew stands", async () => {
    const owner = await person("end2-owner")
    const mate = await person("end2-mate")
    const stranger = await person("end2-x")
    const { crewId } = await crewOf(owner, [mate], "Still Here")
    const asMember = await end(mate, crewId)
    const asStranger = await end(stranger, crewId)
    const none = await end(owner, "00000000-0000-4000-8000-000000000000")
    expect([asMember.status, asStranger.status, none.status]).toEqual([404, 404, 404])
    expect(asMember.body).toEqual(asStranger.body)
    // Control: the crew is untouched, and its owner can still end it.
    expect((await api.detail(mate, crewId)).status).toBe(200)
    expect((await end(owner, crewId)).status).toBe(200)
  })
})
