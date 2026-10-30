const mockPermissions = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: async () => ({ user: { id: "u1", role: "venue_owner" } }) }))
jest.mock("@/lib/org-membership", () => ({ actorFor: async () => ({}) }))
jest.mock("@/lib/rbac", () => ({ eventPermissions: (...a: unknown[]) => mockPermissions(...a) }))
jest.mock("@/lib/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
jest.mock("@/lib/db", () => ({
  db: {
    events: {
      findFirst: jest.fn(async () => ({ id: "e1", title: "Jam", organizer_id: "creator-user-id", venue: { owner_org_id: "o1", claimed_at: null } })),
    },
  },
}))

import { GET } from "@/app/api/events/[id]/route"

/*
 * SCRUM-946. A venue owner may operate an event, not edit it, and was sent the
 * whole row -- including `organizer_id`, the creator's user id. Only someone
 * who can edit the event needs to see who made it.
 */
const call = async () => {
  const res = await GET(new Request("http://localhost/api/events/x"), { params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000e1" }) })
  return { status: res.status, body: await res.json() }
}

describe("GET /api/events/[id]", () => {
  it("leaves the creator's user id out for someone who can operate but not edit", async () => {
    mockPermissions.mockReturnValue({ canOperate: true, canEdit: false })
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.title).toBe("Jam")
    expect(body).not.toHaveProperty("organizer_id")
  })

  it("keeps the whole row for someone who can edit", async () => {
    mockPermissions.mockReturnValue({ canOperate: true, canEdit: true })
    expect((await call()).body.organizer_id).toBe("creator-user-id")
  })

  it("refuses someone who cannot operate", async () => {
    mockPermissions.mockReturnValue({ canOperate: false, canEdit: false })
    expect((await call()).status).toBe(403)
  })
})
