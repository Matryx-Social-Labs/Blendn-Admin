/*
 * The audit log's action filter searches the whole (scoped) log, not the 100
 * newest rows (SCRUM-462).
 *
 * The page loaded the newest 100 rows unfiltered and the timeline filtered
 * them in the browser, so on staging `org.domain.verified` showed "0 of 406"
 * while two rows existed. The filter now reaches `getAuditLog`, and the
 * dropdown keeps every action however the page is filtered.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { isValidElement, type ReactElement, type ReactNode } from "react"
import { closeDb, db, makeUser, testId } from "./helpers"
import type { AuditPage } from "@/lib/audit-actions"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const page = require("@/app/dashboard/audit/page") as typeof import("@/app/dashboard/audit/page")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AuditTimeline } = require("@/app/dashboard/audit/timeline") as typeof import("@/app/dashboard/audit/timeline")

const rare = testId("itest.rare")
const noise = testId("itest.noise")
const users: string[] = []

beforeAll(async () => {
  const admin = await makeUser("audit_admin", "app_admin")
  users.push(admin)
  mockGetAuth.mockResolvedValue({ user: { id: admin, role: "app_admin" } })
  // One old row, then more than a page of newer ones on top of it.
  await db.audit_logs.create({ data: { action: rare, resource: "itest", created_at: new Date("2020-01-01T00:00:00Z") } })
  await db.audit_logs.createMany({ data: Array.from({ length: 105 }, () => ({ action: noise, resource: "itest" })) })
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { action: { in: [rare, noise] } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

/** The page prop handed to the timeline, found in the rendered tree. */
function timelinePage(node: ReactNode): AuditPage | null {
  if (!isValidElement(node)) return null
  const el = node as ReactElement<{ page?: AuditPage; children?: ReactNode }>
  if (el.type === AuditTimeline) return el.props.page ?? null
  const kids = el.props.children
  for (const child of Array.isArray(kids) ? kids : [kids]) {
    const found = timelinePage(child)
    if (found) return found
  }
  return null
}

const render = async (action?: string) =>
  timelinePage(await page.default({ searchParams: Promise.resolve(action ? { action } : {}) }))

it("finds an action older than the newest 100 rows", async () => {
  const unfiltered = await render()
  expect(unfiltered?.entries.some((e) => e.action === rare)).toBe(false)

  const filtered = await render(rare)
  expect(filtered?.entries.map((e) => e.action)).toEqual([rare])
  expect(filtered?.total).toBe(1)
})

it("keeps every action in the dropdown while filtered", async () => {
  const filtered = await render(rare)
  expect(filtered?.actions).toEqual(expect.arrayContaining([rare, noise]))
})
