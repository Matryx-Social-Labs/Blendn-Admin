import { NextRequest, NextResponse } from "next/server"

const mockGetAuth = jest.fn()
const mockCheck = jest.fn()
const mockOn = jest.fn()
const mockLimit = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("@/lib/media-clip", () => ({ checkClip: (...a: unknown[]) => mockCheck(...a), clipCheckOn: () => mockOn() }))
jest.mock("@/lib/rate-limit", () => ({ rateLimit: () => mockLimit(), userLimit: () => ({}) }))

import { POST } from "@/app/api/media/clip/route"

const post = (body: unknown) => POST(new NextRequest("http://localhost/api/media/clip", { method: "POST", body: JSON.stringify(body) }))
const good = { url: "https://cdn.example.com/a.mp4" }

beforeEach(() => {
  mockOn.mockReturnValue(true)
  mockGetAuth.mockResolvedValue({ user: { id: "u1", role: "organizer" } })
  mockLimit.mockResolvedValue(null)
  mockCheck.mockReset().mockResolvedValue({ kind: "ok", clip: { width: 1 } })
})

it("checks an organizer's clip as them", async () => {
  const res = await post(good)
  expect(res.status).toBe(200)
  expect((await res.json()).data).toEqual({ width: 1 })
  expect(mockCheck).toHaveBeenCalledWith(good.url, "u1")
})

it.each([
  ["signed out", () => mockGetAuth.mockResolvedValue(null), 401],
  ["an attendee", () => mockGetAuth.mockResolvedValue({ user: { id: "u1", role: "attendee" } }), 403],
  ["a sponsor", () => mockGetAuth.mockResolvedValue({ user: { id: "u1", role: "sponsor" } }), 403],
  ["over the limit", () => mockLimit.mockResolvedValue(NextResponse.json({}, { status: 429 })), 429],
  ["switched off", () => mockOn.mockReturnValue(false), 503],
])("asks the worker nothing for %s", async (_who, set, status) => {
  set()
  expect((await post(good)).status).toBe(status)
  expect(mockCheck).not.toHaveBeenCalled()
})

it.each([{}, { url: "http://cdn.example.com/a.mp4" }, { url: "https://a:b@cdn.example.com/a.mp4" }, { url: 3 }])("refuses a bad link: %j", async (body) => {
  expect((await post(body)).status).toBe(400)
  expect(mockCheck).not.toHaveBeenCalled()
})

it("says a verdict as a 422 in words, and an unanswered check as a 503", async () => {
  mockCheck.mockResolvedValueOnce({ kind: "refused", message: "This clip is 20.2 seconds." })
  const refused = await post(good)
  expect(refused.status).toBe(422)
  expect(await refused.json()).toMatchObject({ error: "This clip is 20.2 seconds.", errorCode: "CLIP_REFUSED" })
  mockCheck.mockResolvedValueOnce({ kind: "unavailable" })
  expect((await post(good)).status).toBe(503)
})
