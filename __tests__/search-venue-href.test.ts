/*
 * A venue hit in ⌘K opens that venue (step 14 review).
 *
 * It linked to `/dashboard/venue-owners`, a list of owner ACCOUNTS that only an
 * admin may open, so a venue owner searching their own venue was redirected to
 * the overview. The palette now sits in every host's top bar, which made the
 * dead end visible to every host.
 */
jest.mock("@/lib/auth", () => ({
  getAuth: () => Promise.resolve({ user: { id: "u1", role: "venue_owner" } }),
}))
jest.mock("@/lib/rate-limit", () => ({ rateLimit: () => Promise.resolve(null), userLimit: () => ({}) }))
jest.mock("@/lib/event-visibility", () => ({ visibleEventsWhere: () => Promise.resolve({}) }))
jest.mock("@/lib/db", () => ({
  db: {
    organisation_members: { findMany: () => Promise.resolve([{ org_id: "o1" }]) },
    events: { findMany: () => Promise.resolve([]) },
    user: { findMany: () => Promise.resolve([]) },
    organisations: { findMany: () => Promise.resolve([]) },
    venues: {
      findMany: () => Promise.resolve([{ id: "v-123", name: "The Humming Tree", city: "Bengaluru" }]),
    },
  },
}))

import { NextRequest } from "next/server"

import { GET } from "@/app/api/search/route"

it("links a venue hit to the venue's own page", async () => {
  const res = await GET(new NextRequest("http://localhost/api/search?q=humming"))
  const { hits } = await res.json()
  expect(hits).toEqual([
    expect.objectContaining({ type: "venue", href: "/dashboard/venues/v-123" }),
  ])
})
