process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"

/*
 * `GET /events/:eventId/rating` — your own rating, so the rate screen opens on
 * the stars you gave. Yours only: nothing returns anybody else's.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockDb = {
  events: { findUnique: jest.fn() },
  event_ratings: { findUnique: jest.fn() },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

const mockAuth = jest.fn()
jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: (...a: unknown[]) => mockAuth(...a) }))

import { NextRequest } from "next/server"
import { GET } from "@/app/api/mobile/events/[eventId]/rating/route"

const EVENT = "e0000000-0000-4000-8000-000000000001"

async function call(eventId = EVENT) {
  const res = await GET(new NextRequest(`https://api.blendn.app/api/mobile/events/${eventId}/rating`), {
    params: Promise.resolve({ eventId }),
  })
  return { status: res.status, json: await res.json() }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: "user_me", email: "me@b.com" })
  mockDb.events.findUnique.mockResolvedValue({ id: EVENT })
  mockDb.event_ratings.findUnique.mockResolvedValue(null)
})

it("returns your rating and when you last set it", async () => {
  const at = new Date("2026-09-28T23:10:00Z")
  mockDb.event_ratings.findUnique.mockResolvedValue({ rating: 4, review: "Great crowd", updated_at: at })
  const res = await call()
  expect(res.status).toBe(200)
  expect(res.json.data).toEqual({ rating: 4, review: "Great crowd", ratedAt: at.toISOString() })
})

it("is keyed on the caller, never on anybody else", async () => {
  await call()
  expect(mockDb.event_ratings.findUnique.mock.calls[0][0].where).toEqual({
    event_id_user_id: { event_id: EVENT, user_id: "user_me" },
  })
})

it("answers null when you have not rated", async () => {
  const res = await call()
  expect(res.status).toBe(200)
  expect(res.json.data).toEqual({ rating: null, review: null, ratedAt: null })
})

it("404s NOT_FOUND an unknown, deleted or malformed event", async () => {
  mockDb.events.findUnique.mockResolvedValue(null)
  const gone = await call()
  expect(gone.status).toBe(404)
  expect(gone.json.errorCode).toBe("NOT_FOUND")
  expect(mockDb.events.findUnique.mock.calls[0][0].where).toMatchObject({ deleted_at: null })

  const malformed = await call("not-an-id")
  expect(malformed.status).toBe(404)
  expect(malformed.json.errorCode).toBe("NOT_FOUND")
})

it("401s without a token", async () => {
  mockAuth.mockResolvedValue(null)
  expect((await call()).status).toBe(401)
})
