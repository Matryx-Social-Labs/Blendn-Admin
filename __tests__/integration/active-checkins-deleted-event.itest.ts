/**
 * A check-in at an event that was deleted is not "active".
 *
 * Driven 2026-10-26: a seed soft-deleted an event a person was checked in to,
 * and the app's check-in screen sat on skeletons — GET /checkins/active still
 * named the event, whose detail then 404'd. The row's status is the sweeper's
 * business; what the phone is told is active is this route's.
 */
import { NextRequest } from "next/server"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom } from "./helpers"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

const users: string[] = []
const events: string[] = []
afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

const active = async (token: string) => {
  const { GET } = await import("@/app/api/mobile/checkins/active/route")
  const res = await GET(new NextRequest("http://localhost/api/mobile/checkins/active", { headers: { Authorization: `Bearer ${token}` } }))
  return ((await res.json()).data.checkIns as Array<{ eventId: string }>).map((c) => c.eventId)
}

it("does not name an event that was deleted while you were checked in", async () => {
  const host = await makeUser("acd-host", "organizer")
  const me = await makeUser("acd-me")
  users.push(host, me)
  const kept = await makeEvent(host)
  events.push(kept)
  await putInRoom({ eventId: kept, occurrenceId: await occurrenceOf(kept), userId: me })
  const token = signAccessToken(me, `${me}@test.blendn`)
  expect(await active(token)).toContain(kept)

  await db.events.update({ where: { id: kept }, data: { deleted_at: new Date() } })
  expect(await active(token)).not.toContain(kept)
})
