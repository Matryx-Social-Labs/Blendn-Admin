import { ORGANIZER_TICKETING_TERMS, latestLegalAcceptance, recordLegalAcceptance } from "@/lib/legal-acceptance"

import { closeDb, db, makeUser, testId } from "./helpers"

/**
 * The organizer ticketing terms, accepted by clickwrap (SCRUM-1008;
 * organizer-ticketing-terms-draft.md, "How acceptance works").
 *
 * Fixtures are left behind on purpose: `legal_acceptances` refuses DELETE and
 * TRUNCATE, and its foreign keys are RESTRICT, so its rows, their users and
 * their organisations stay. Every name here is namespaced by `testId`.
 */

const { key: TERMS, version: CURRENT } = ORGANIZER_TICKETING_TERMS

let previousFlag: string | undefined
beforeAll(() => {
  previousFlag = process.env.TICKETING
  process.env.TICKETING = "true"
})
afterAll(async () => {
  process.env.TICKETING = previousFlag
  await closeDb()
})

async function orgWith(role: "owner" | "admin" | "staff") {
  const org = await db.organisations.create({ data: { display_name: testId("la-org"), kind: "company", status: "verified" }, select: { id: true } })
  const userId = await makeUser(testId("la-user"), "organizer")
  await db.organisation_members.create({ data: { org_id: org.id, user_id: userId, role } })
  return { orgId: org.id, userId }
}

const accept = (orgId: string, userId: string, over: Partial<Parameters<typeof recordLegalAcceptance>[0]> = {}) =>
  recordLegalAcceptance({ orgId, userId, documentKey: TERMS, version: CURRENT, ip: "203.0.113.7", userAgent: "Mozilla/5.0 itest", ...over })

describe("recording an acceptance", () => {
  it("writes who, for which organisation, what, which version, when, from where — and an audit row", async () => {
    const { orgId, userId } = await orgWith("owner")
    const at = new Date("2026-11-02T10:00:00Z")

    const result = await accept(orgId, userId, { now: at })

    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    const row = await db.legal_acceptances.findUniqueOrThrow({ where: { id: result.acceptance.id } })
    expect(row).toMatchObject({ org_id: orgId, user_id: userId, document_key: TERMS, version: CURRENT, accepted_at: at, ip: "203.0.113.7", user_agent: "Mozilla/5.0 itest" })
    const audit = await db.audit_logs.findFirstOrThrow({ where: { action: "legal.accept", resource_id: orgId } })
    expect(audit).toMatchObject({
      user_id: userId,
      resource: "organisation",
      org_id: orgId,
      ip_address: "203.0.113.7",
      details: { documentKey: TERMS, version: CURRENT, acceptanceId: row.id },
    })
  })

  it("an admin of the organisation may accept", async () => {
    const { orgId, userId } = await orgWith("admin")
    expect((await accept(orgId, userId)).ok).toBe(true)
  })

  it("keeps an unusable address out and a long user agent short", async () => {
    const { orgId, userId } = await orgWith("owner")
    const result = await accept(orgId, userId, { ip: "not-an-ip; DROP TABLE", userAgent: "x".repeat(2_000) })
    if (!result.ok) throw new Error("refused")
    const row = await db.legal_acceptances.findUniqueOrThrow({ where: { id: result.acceptance.id } })
    expect(row.ip).toBeNull()
    expect(row.user_agent).toHaveLength(512)
  })
})

describe("who may bind an organisation", () => {
  it("not staff", async () => {
    const { orgId, userId } = await orgWith("staff")
    expect(await accept(orgId, userId)).toEqual({ ok: false, reason: "not_authorized" })
    expect(await db.legal_acceptances.count({ where: { org_id: orgId } })).toBe(0)
  })

  it("not someone from another organisation", async () => {
    const mine = await orgWith("owner")
    const theirs = await orgWith("owner")
    expect(await accept(mine.orgId, theirs.userId)).toEqual({ ok: false, reason: "not_authorized" })
  })

  it("not the owner of a suspended organisation", async () => {
    const { orgId, userId } = await orgWith("owner")
    await db.organisations.update({ where: { id: orgId }, data: { status: "suspended" } })
    expect(await accept(orgId, userId)).toEqual({ ok: false, reason: "not_authorized" })
  })
})

describe("what may be accepted", () => {
  it("only the version in force: a stale tab is asked to read again", async () => {
    const { orgId, userId } = await orgWith("owner")
    expect(await accept(orgId, userId, { version: "0.0" })).toEqual({ ok: false, reason: "stale_version" })
  })

  it("only a document we have", async () => {
    const { orgId, userId } = await orgWith("owner")
    expect(await accept(orgId, userId, { documentKey: "something-else" })).toEqual({ ok: false, reason: "unknown_document" })
  })

  it("nothing while TICKETING is off", async () => {
    const { orgId, userId } = await orgWith("owner")
    process.env.TICKETING = "false"
    try {
      expect(await accept(orgId, userId)).toEqual({ ok: false, reason: "ticketing_off" })
    } finally {
      process.env.TICKETING = "true"
    }
  })
})

describe("the latest acceptance", () => {
  it("is the newest for that organisation and document, whoever accepted", async () => {
    const { orgId, userId } = await orgWith("owner")
    const colleague = await makeUser(testId("la-colleague"), "organizer")
    await db.organisation_members.create({ data: { org_id: orgId, user_id: colleague, role: "admin" } })
    await accept(orgId, userId, { now: new Date("2026-11-02T09:00:00Z") })
    await accept(orgId, colleague, { now: new Date("2026-11-03T09:00:00Z") })

    expect(await latestLegalAcceptance(orgId, TERMS)).toMatchObject({ userId: colleague, version: CURRENT, acceptedAt: new Date("2026-11-03T09:00:00Z") })
  })

  it("is null for an organisation that never accepted", async () => {
    const { orgId } = await orgWith("owner")
    expect(await latestLegalAcceptance(orgId, TERMS)).toBeNull()
  })

  it("is per organisation", async () => {
    const a = await orgWith("owner")
    const b = await orgWith("owner")
    await accept(a.orgId, a.userId)
    expect(await latestLegalAcceptance(b.orgId, TERMS)).toBeNull()
  })
})

describe("the record is append-only (trigger, migration SQL only)", () => {
  it("refuses an UPDATE", async () => {
    const { orgId, userId } = await orgWith("owner")
    const r = await accept(orgId, userId)
    if (!r.ok) throw new Error("refused")
    await expect(db.legal_acceptances.update({ where: { id: r.acceptance.id }, data: { version: "9.9" } })).rejects.toThrow(/append-only/)
  })

  it("refuses a DELETE", async () => {
    const { orgId, userId } = await orgWith("owner")
    const r = await accept(orgId, userId)
    if (!r.ok) throw new Error("refused")
    await expect(db.$executeRaw`DELETE FROM legal_acceptances WHERE id = ${r.acceptance.id}::uuid`).rejects.toThrow(/append-only/)
  })

  it("refuses a TRUNCATE", async () => {
    await expect(db.$executeRawUnsafe(`TRUNCATE legal_acceptances`)).rejects.toThrow(/append-only/)
  })

  it("and its organisation cannot be deleted out from under it", async () => {
    const { orgId, userId } = await orgWith("owner")
    await accept(orgId, userId)
    await expect(db.$executeRaw`DELETE FROM organisations WHERE id = ${orgId}::uuid`).rejects.toThrow(/legal_acceptances_org_id_fkey/)
  })
})
