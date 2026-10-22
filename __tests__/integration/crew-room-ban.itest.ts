jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-crew-room-ban-secret-of-32-characters"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { presentMembersAt } from "@/lib/crews/presence"
import { roomHandle } from "@/lib/room-handle"

import { db } from "./helpers"
import { api, arrive, cleanupCrewWorld, crewOf, liveEvent, person, type Person } from "./crew-world"

/**
 * Crews and a host's ban (review H2): a member a host banned from the room is
 * not here for their crew, may not like a crew or say "we're here" for one,
 * and is not here to be liked by one — answered as a like that stood, with
 * nothing stored.
 */

afterAll(async () => {
  await cleanupCrewWorld()
})

async function hostBan(eventId: string, p: Person) {
  const room = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })
  await db.chat_group_members.updateMany({ where: { chat_group_id: room.id, user_id: p.id }, data: { status: "banned", banned_by: "itest-host" } })
}

async function world(label: string) {
  const host = await person(`${label}-host`)
  const { eventId, occurrenceId } = await liveEvent(host.id)
  const crew = await Promise.all(["c0", "c1", "c2"].map((l) => person(`${label}-${l}`)))
  const C = await crewOf(crew[0], crew.slice(1), "Room For One")
  await db.crews.update({ where: { id: C.crewId }, data: { open_to_solo: true, intent: ["friendship"] } })
  const solo = await person(`${label}-solo`, "Meera Iyer")
  for (const p of [...crew, solo]) await arrive(eventId, occurrenceId, p)
  return { eventId, occurrenceId, crew, C, solo }
}

const REFUSED = { error: "The organiser has removed you from this room.", errorCode: "USER_BANNED" }

it("a member a host banned is not here for their crew", async () => {
  const w = await world("present")
  expect((await presentMembersAt(w.occurrenceId, [w.C.crewId])).get(w.C.crewId)?.sort()).toEqual(w.crew.map((p) => p.id).sort())
  await hostBan(w.eventId, w.crew[2])
  expect((await presentMembersAt(w.occurrenceId, [w.C.crewId])).get(w.C.crewId)?.sort()).toEqual([w.crew[0].id, w.crew[1].id].sort())
})

it("refuses a banned member a crew like and \"we're here\", as the chat does", async () => {
  const w = await world("gate")
  await hostBan(w.eventId, w.solo)
  const like = await api.likeCrew(w.solo, w.eventId, w.C.crewId)
  expect(like.status).toBe(403)
  expect(like.body).toMatchObject(REFUSED)

  await hostBan(w.eventId, w.crew[1])
  const here = await api.here(w.crew[1], w.C.crewId, w.eventId)
  expect(here.status).toBe(403)
  expect(here.body).toMatchObject(REFUSED)
})

it("a banned person is not here to be liked by a crew: the answer of a like that stood, and nothing stored", async () => {
  const w = await world("liked")
  await api.prefs(w.solo, w.eventId, { openToCrews: true })
  await hostBan(w.eventId, w.solo)
  const res = await api.likePerson(w.crew[0], w.eventId, roomHandle(w.eventId, w.solo.id), w.C.crewId)
  expect(res).toEqual({ status: 200, body: expect.objectContaining({ data: { liked: true, blend: null } }) })
  expect(await db.crew_likes.count({ where: { occurrence_id: w.occurrenceId, to_user_id: w.solo.id } })).toBe(0)
})
