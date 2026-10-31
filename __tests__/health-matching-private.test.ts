/**
 * SCRUM-946 (owner row 20, decided by lean 2026-10-31; reverse if wanted): `/api/health` is public, unlimited and uncached,
 * and Railway reads only its status code. It no longer carries product metrics: the matching coverage (how many people who
 * turned up can be ranked) moved to `/api/health/matching`, which answers an app admin only.
 */
const mockCurrentUser = jest.fn()
const mockCoverage = jest.fn()
jest.mock("@/lib/current-user", () => ({ currentUser: () => mockCurrentUser() }))
jest.mock("@/lib/db", () => ({ db: { $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]) } }))
jest.mock("@/lib/interest-coverage", () => ({ MIN_INTERESTS_TO_RANK: 3, interestCoverage: () => mockCoverage() }))
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

import { GET as health } from "@/app/api/health/route"
import { GET as matching } from "@/app/api/health/matching/route"

beforeEach(() => {
  jest.clearAllMocks()
  mockCoverage.mockResolvedValue({ status: "ok", attendees: 10, rankable: 9, minInterestsToRank: 3 })
})

it("the public health body is infrastructure only: no matching coverage, and the query is never run", async () => {
  const res = await health()
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toMatchObject({ status: "ok", database: "connected" })
  expect(body).not.toHaveProperty("matching")
  expect(mockCoverage).not.toHaveBeenCalled()
})

it.each([
  ["nobody signed in", null],
  ["an organizer", { id: "o", role: "organizer" }],
  ["an attendee", { id: "a", role: "attendee" }],
])("matching coverage is a 404 for %s", async (_who, user) => {
  mockCurrentUser.mockResolvedValue(user)
  const res = await matching()
  expect(res.status).toBe(404)
  expect(mockCoverage).not.toHaveBeenCalled()
})

it("an app admin reads matching coverage, uncached", async () => {
  mockCurrentUser.mockResolvedValue({ id: "ad", role: "app_admin" })
  const res = await matching()
  expect(res.status).toBe(200)
  expect(res.headers.get("cache-control")).toBe("no-store")
  expect(await res.json()).toEqual({ status: "ok", attendees: 10, rankable: 9, minInterestsToRank: 3 })
})
