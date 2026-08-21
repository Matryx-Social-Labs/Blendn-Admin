/*
 * `events.organizer_org_id` is the column `lib/rbac.ts` is built on, and
 * nothing in production ever wrote it.
 *
 * The only assignments in the repo were two seed scripts. So every event
 * created through the product had it null, `eventPermissions` could never match
 * the organiser branch (`lib/rbac.ts` guards on `event.organizer_org_id &&`),
 * and an organiser could not edit the event they had just saved. `GET
 * /api/events` worked only because of a legacy `organizer_id` clause its own
 * comment describes as a compatibility shim for events predating organisations
 * — a shim that was, in fact, load-bearing for every event in the database.
 *
 * The ordering is the part worth pinning. `lib/venue-actions.ts` resolves a
 * creator's org with `findFirst` and no `orderBy`, so a multi-org user can get
 * either row — and which one they get decides who else may edit the thing. The
 * backfill migration applies the same oldest-membership rule, so a row written
 * today and a row backfilled from before it agree.
 */
const mockDb = {
  organisation_members: { findFirst: jest.fn() },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

import { readFileSync } from "fs"
import { join } from "path"

import { owningOrgFor } from "@/lib/event-ownership"

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.organisation_members.findFirst.mockResolvedValue({ org_id: "org-1" })
})

describe("owningOrgFor", () => {
  it("returns the organiser's org", async () => {
    expect(await owningOrgFor({ id: "u1", role: "organizer" })).toBe("org-1")
  })

  it("picks deterministically by oldest membership", async () => {
    /*
     * Not `findFirst` with no order. Two saves by the same multi-org person
     * must not land on different organisations, because that changes who else
     * can edit the event.
     */
    await owningOrgFor({ id: "u1", role: "organizer" })
    expect(mockDb.organisation_members.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { created_at: "asc" } })
    )
  })

  it("throws rather than writing null when the creator has no org", async () => {
    /*
     * Writing null is what the product did for its whole life, and the symptom
     * was silent: the event saved, appeared in the list, and refused its own
     * creator at the edit screen.
     */
    mockDb.organisation_members.findFirst.mockResolvedValue(null)
    await expect(owningOrgFor({ id: "u1", role: "organizer" })).rejects.toThrow(
      /not attached to an organisation/i
    )
  })

  it("returns null for an admin without querying", async () => {
    // `eventPermissions` short-circuits app_admin before it looks at ownership.
    expect(await owningOrgFor({ id: "a1", role: "app_admin" })).toBeNull()
    expect(mockDb.organisation_members.findFirst).not.toHaveBeenCalled()
  })
})

describe("the write paths set it", () => {
  const code = (rel: string) =>
    readFileSync(join(__dirname, "..", rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")

  it("POST /api/events writes organizer_org_id", () => {
    expect(code("app/api/events/route.ts")).toMatch(/organizer_org_id:\s*owningOrgId/)
  })

  it("the clone route writes it too, resolved from the cloner", () => {
    /*
     * The clone landed org-less, so cloning produced an event its own cloner
     * could not edit. Resolved from the cloner rather than copied from the
     * source: cloning somebody else's event makes it yours, and inheriting
     * their org would hand them edit rights over your copy.
     */
    const src = code("app/api/mobile/events/[eventId]/clone/route.ts")
    expect(src).toMatch(/organizer_org_id:\s*await owningOrgFor\(/)
    expect(src).toMatch(/requester\.id/)
  })
})

describe("the backfill agrees with the runtime rule", () => {
  const sql = () =>
    readFileSync(
      join(__dirname, "..", "prisma", "migrations", "20260820210000_backfill_organizer_org", "migration.sql"),
      "utf8"
    )

  it("picks the oldest membership, like owningOrgFor", () => {
    /*
     * If these two disagreed, an event written today and one backfilled from
     * yesterday would land on different organisations for the same creator.
     */
    expect(sql()).toMatch(/DISTINCT ON \("user_id"\)/)
    expect(sql()).toMatch(/ORDER BY "user_id", "created_at" ASC/)
  })

  it("only fills rows that are still null, so it is re-runnable", () => {
    expect(sql()).toMatch(/"organizer_org_id" IS NULL/)
  })
})
