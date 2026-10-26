import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { getOccupancy } from "@/lib/occupancy"

import { db, cleanup, closeDb, makeUser, makeEvent, occurrenceOf, putInRoom, testId } from "./helpers"
import { recordStatements, shape } from "./statements"

/**
 * The event detail's `currentCapacity` is who is inside right now. It was
 * `getOccupancy(...).inside`, run after the event query, and that function also
 * reads the event's capacity and every attendee's check-in row for
 * `uniqueAttendance`, which this route never shows. The number must not move;
 * the unused read and the extra wait must go.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const detailRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")

const users: string[] = []
let eventId: string
let token: string

// `uniqueAttendance`'s read: every attendee's check-in row (Prisma applies `distinct` in memory).
const UNIQUE_ATTENDANCE_READ =
  /SELECT "public"\."event_check_ins"\."id", "public"\."event_check_ins"\."user_id" FROM "public"\."event_check_ins" WHERE .*"check_in_time" IS NOT NULL/

beforeAll(async () => {
  const organiser = await makeUser(testId("occ_det_org"), "organizer")
  const viewer = await makeUser(testId("occ_det_viewer"))
  users.push(organiser, viewer)
  await db.profiles.create({ data: { id: viewer, onboarded: true } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: viewer }, select: { email: true } })
  token = signAccessToken(viewer, email)

  eventId = await makeEvent(organiser)
  const occurrenceId = await occurrenceOf(eventId)
  for (const [label, kind] of [["a", "attendee"], ["b", "attendee"], ["crew", "staff"]] as const) {
    const userId = await makeUser(testId(`occ_det_${label}`))
    users.push(userId)
    await putInRoom({ eventId, occurrenceId, userId, kind })
  }
})

afterAll(async () => {
  await db.event_occurrences.deleteMany({ where: { event_id: eventId } })
  await cleanup(users, [eventId])
  await closeDb()
})

it("currentCapacity is who is inside, staff included, as getOccupancy says; the unique-attendance read is gone", async () => {
  const { result: res, statements } = await recordStatements(() =>
    detailRoute.GET(
      new NextRequest(`http://localhost/api/mobile/events/${eventId}`, { headers: { authorization: `Bearer ${token}` } }),
      { params: Promise.resolve({ eventId }) }
    )
  )
  expect(res.status).toBe(200)
  const body = (await res.json()).data
  expect(body.currentCapacity).toBe(3)
  expect(body.currentCapacity).toBe((await getOccupancy(eventId)).inside)
  console.log("detail:", shape(statements))
  // The headcount itself was read (positive), and the unique-attendance read was not.
  expect(statements.some((s) => /presence_sessions/.test(s.sql))).toBe(true)
  expect(statements.filter((s) => UNIQUE_ATTENDANCE_READ.test(s.sql)).length).toBe(0)
})
