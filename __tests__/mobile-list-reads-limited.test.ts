import { NextRequest, NextResponse } from "next/server"

/*
 * SCRUM-946. Eight authenticated list reads answered at any rate: the events
 * feed (up to 5,000 rows in memory for the distance sort), every future city,
 * a to_tsvector scan over four columns, and the room reads. Each is now held
 * to the per-user `read` policy before it touches the database.
 */
const mockUser = { userId: "00000000-0000-4000-8000-000000000001" }
jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: jest.fn(async () => mockUser) }))
jest.mock("@/lib/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
jest.mock("@/lib/product-events", () => ({ PRODUCT_EVENTS: {}, record: jest.fn() }))
// Any query before the limiter is a failure: the proxy throws, which would surface as 500, not 429.
jest.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: () => { throw new Error("db touched before the limiter") } }),
}))
jest.mock("@/lib/rate-limit", () => ({
  userLimit: jest.fn((policy: string, scope: string, userId: string) => ({ policy, scope, userId })),
  rateLimit: jest.fn(async () => NextResponse.json({ success: false }, { status: 429 })),
}))

import { userLimit } from "@/lib/rate-limit"
import { GET as events } from "@/app/api/mobile/events/route"
import { GET as cities } from "@/app/api/mobile/events/cities/route"
import { GET as search } from "@/app/api/mobile/events/search/route"
import { GET as roomPreview } from "@/app/api/mobile/events/[eventId]/room-preview/route"
import { GET as matches } from "@/app/api/mobile/events/[eventId]/matches/route"
import { GET as checkins } from "@/app/api/mobile/events/[eventId]/checkins/route"
import { GET as interested } from "@/app/api/mobile/events/[eventId]/interested-users/route"
import { GET as groups } from "@/app/api/mobile/chat/groups/route"

const eventId = "00000000-0000-4000-8000-0000000000e1"
const ctx = { params: Promise.resolve({ eventId }) }
const req = (path: string) => new NextRequest(`http://localhost${path}`)

const routes: Array<[string, (r: NextRequest, c: typeof ctx) => Promise<Response>, string]> = [
  ["/api/mobile/events", events as never, "events-list"],
  ["/api/mobile/events/cities", cities as never, "events-cities"],
  ["/api/mobile/events/search?q=jazz", search as never, "events-search"],
  [`/api/mobile/events/${eventId}/room-preview`, roomPreview as never, "room-preview"],
  [`/api/mobile/events/${eventId}/matches`, matches as never, "event-matches"],
  [`/api/mobile/events/${eventId}/checkins`, checkins as never, "event-checkins"],
  [`/api/mobile/events/${eventId}/interested-users`, interested as never, "interested-users"],
  ["/api/mobile/chat/groups", groups as never, "chat-groups"],
]

describe("authenticated list reads are rate limited per user, before any query", () => {
  it.each(routes)("%s answers 429 once over the read policy", async (path, handler, scope) => {
    const res = await handler(req(path), ctx)
    expect(res.status).toBe(429)
    expect(userLimit).toHaveBeenCalledWith("read", scope, mockUser.userId)
  })
})
