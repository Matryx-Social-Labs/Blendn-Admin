import { createHash } from "node:crypto"

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
/** What the server rendered: the hash of the exact text shown. */
const SHOWN = createHash("sha256").update("Organizer ticketing terms 0.1 — the text as shown").digest("hex")

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
  recordLegalAcceptance({ orgId, userId, documentKey: TERMS, version: CURRENT, documentSha256: SHOWN, ip: "203.0.113.7", userAgent: "Mozilla/5.0 itest", ...over })

describe("recording an acceptance", () => {
  it("writes who, for which organisation, what text, which version, when, from which network — and an audit row", async () => {
    const { orgId, userId } = await orgWith("owner")
    const before = Date.now()

    const result = await accept(orgId, userId)

    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    const row = await db.legal_acceptances.findUniqueOrThrow({ where: { id: result.acceptance.id } })
    expect(row).toMatchObject({ org_id: orgId, user_id: userId, document_key: TERMS, version: CURRENT, document_sha256: SHOWN, ip: "203.0.113.0/24", user_agent: "Mozilla/5.0 itest" })
    // The database's clock, not one a caller could pass.
    expect(row.accepted_at.getTime()).toBeGreaterThanOrEqual(before - 5_000)
    expect(row.accepted_at.getTime()).toBeLessThanOrEqual(Date.now() + 5_000)
    const audit = await db.audit_logs.findFirstOrThrow({ where: { action: "legal.accept", resource_id: orgId } })
    expect(audit).toMatchObject({
      user_id: userId,
      resource: "organisation",
      org_id: orgId,
      ip_address: "203.0.113.0/24",
      details: { documentKey: TERMS, version: CURRENT, documentSha256: SHOWN, acceptanceId: row.id },
    })
  })

  it("keeps an IPv6 address as its /48, here and on the audit row (security M1)", async () => {
    const { orgId, userId } = await orgWith("owner")
    const result = await accept(orgId, userId, { ip: "2001:db8:85a3:8d3:1319:8a2e:370:7348" })
    if (!result.ok) throw new Error("refused")
    expect((await db.legal_acceptances.findUniqueOrThrow({ where: { id: result.acceptance.id } })).ip).toBe("2001:db8:85a3::/48")
    expect((await db.audit_logs.findFirstOrThrow({ where: { action: "legal.accept", resource_id: orgId } })).ip_address).toBe("2001:db8:85a3::/48")
  })

  it("refuses a document hash that is not one (security L2)", async () => {
    const { orgId, userId } = await orgWith("owner")
    expect(await accept(orgId, userId, { documentSha256: "not-a-hash" })).toEqual({ ok: false, reason: "bad_document_hash" })
    expect(await accept(orgId, userId, { documentSha256: SHOWN.toUpperCase() })).toEqual({ ok: false, reason: "bad_document_hash" })
    expect(await db.legal_acceptances.count({ where: { org_id: orgId } })).toBe(0)
  })

  it("an admin of the organisation may accept", async () => {
    const { orgId, userId } = await orgWith("admin")
    expect((await accept(orgId, userId)).ok).toBe(true)
  })

  it("keeps an unusable address out and a long user agent short", async () => {
    const { orgId, userId } = await orgWith("owner")
    // 2,000 emoji: cut by code points, never into half a surrogate pair (security M2).
    const result = await accept(orgId, userId, { ip: "not-an-ip; DROP TABLE", userAgent: "🎟".repeat(2_000) })
    if (!result.ok) throw new Error("refused")
    const row = await db.legal_acceptances.findUniqueOrThrow({ where: { id: result.acceptance.id } })
    expect(row.ip).toBeNull()
    expect(Array.from(row.user_agent ?? "")).toHaveLength(200)
    expect(row.user_agent).toBe("🎟".repeat(200))
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

  it("not a suspended owner of a live organisation (database 12)", async () => {
    const { orgId, userId } = await orgWith("owner")
    await db.user.update({ where: { id: userId }, data: { suspended_at: new Date() } })
    expect(await accept(orgId, userId)).toEqual({ ok: false, reason: "not_authorized" })
    expect(await db.legal_acceptances.count({ where: { org_id: orgId } })).toBe(0)
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
    await accept(orgId, userId)
    const second = await accept(orgId, colleague)
    if (!second.ok) throw new Error("refused")

    expect(await latestLegalAcceptance(orgId, TERMS)).toMatchObject({ userId: colleague, version: CURRENT, acceptedAt: second.acceptance.acceptedAt })
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

describe("the CHECKs on what an acceptance keeps (NOT VALID: every row from 20261102160000 on)", () => {
  const raw = async (over: Record<string, unknown>) => {
    const { orgId, userId } = await orgWith("owner")
    return db.legal_acceptances.create({ data: { org_id: orgId, user_id: userId, document_key: TERMS, version: CURRENT, document_sha256: SHOWN, ...over } })
  }

  it.each([
    ["a whole IPv4 address", { ip: "203.0.113.7" }, "legal_acceptances_ip_truncated"],
    ["a whole IPv6 address", { ip: "2001:db8::1" }, "legal_acceptances_ip_truncated"],
    ["no document hash", { document_sha256: null }, "legal_acceptances_document_sha256_shape"],
    ["a document hash that is not hex sha256", { document_sha256: "x".repeat(64) }, "legal_acceptances_document_sha256_shape"],
    ["a user agent past 200 characters", { user_agent: "a".repeat(201) }, "legal_acceptances_user_agent_length"],
  ])("refuses %s", async (_name, over, constraint) => {
    await expect(raw(over)).rejects.toThrow(new RegExp(constraint))
  })

  it("takes a /24 and a /48", async () => {
    await raw({ ip: "198.51.100.0/24" })
    await raw({ ip: "2001:db8:0::/48" })
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
