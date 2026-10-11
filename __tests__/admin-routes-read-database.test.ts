/**
 * The API reference and the leads export answer on the role the database
 * holds now (step 18 security review, L1 and L5). Every caller here carries a
 * cookie that says app_admin; only the row behind it differs.
 */
let mockRow: { role: string; suspended_at: Date | null; deletedAt: Date | null } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: jest.fn().mockResolvedValue({ user: { id: "u1", role: "app_admin" } }) }))
jest.mock("@/lib/db", () => ({ db: { user: { findUnique: jest.fn(async () => mockRow) } } }))
jest.mock("@/lib/lead-queries", () => ({ getLeads: jest.fn().mockResolvedValue([]) }))

import { NextRequest } from "next/server"

import { GET as docs } from "@/app/api/docs/route"
import { GET as exportLeads } from "@/app/api/leads/export/route"

const row = (role: string, suspended = false) => {
  mockRow = { role, suspended_at: suspended ? new Date() : null, deletedAt: null }
}
const leadsReq = () => new NextRequest("http://localhost/api/leads/export?status=all")

describe("the API reference", () => {
  it("is a 404 to an organiser whose cookie still says admin, and to a suspended admin", async () => {
    row("organizer")
    expect((await docs()).status).toBe(404)
    row("app_admin", true)
    expect((await docs()).status).toBe(404)
  })

  it("is the spec to an admin's row", async () => {
    row("app_admin")
    const res = await docs()
    expect(res.status).toBe(200)
    expect((await res.json()).openapi).toBeTruthy()
  })
})

describe("the leads export", () => {
  it("is refused to an organiser whose cookie still says admin", async () => {
    row("organizer")
    expect((await exportLeads(leadsReq())).status).toBe(403)
  })

  it("is the CSV to an admin's row", async () => {
    row("app_admin")
    const res = await exportLeads(leadsReq())
    expect(res.status).toBe(200)
  })
})
