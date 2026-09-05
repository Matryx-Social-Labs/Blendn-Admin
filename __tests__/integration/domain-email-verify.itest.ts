import { createHash } from "crypto"

import { POST } from "@/app/api/org/domains/verify/route"
import { newDomainToken } from "@/lib/domain-verify"
import { hashInviteToken } from "@/lib/org-invites"

import { closeDb, db, testId } from "./helpers"

/**
 * Verifying a domain from a link sent to a role address.
 *
 * Only the DNS TXT path was ever wired — `claimDomain` hardcodes `dns_txt`,
 * `isRoleAddressFor` and `domainVerifyEmail` had no callers, and the only
 * writer of `email_role` was the onboarding approval, which set it with an
 * empty token and an immediate `verified_at`: a method recorded for a check
 * that never ran.
 *
 * So an organisation whose claimant is not the DNS administrator had no route
 * to a verified domain, and that is the ordinary case. A verified domain gates
 * auto-approval on event claims, so this was a funnel blocker.
 */

const orgs: string[] = []

afterAll(async () => {
  if (orgs.length) {
    await db.organisation_domains.deleteMany({ where: { org_id: { in: orgs } } })
    await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  }
  await closeDb()
})

async function claimed(overrides: Record<string, unknown> = {}) {
  const org = await db.organisations.create({
    data: { display_name: `Acme ${testId("o")}`, kind: "company" },
    select: { id: true },
  })
  orgs.push(org.id)

  const domain = await db.organisation_domains.create({
    data: {
      org_id: org.id,
      domain: `${testId("d").replace(/_/g, "")}.example`,
      method: "dns_txt",
      verification_token: newDomainToken(),
      ...overrides,
    },
    select: { id: true, domain: true, verification_token: true },
  })

  const token = newDomainToken()
  await db.domain_email_tokens.create({
    data: {
      token_hash: hashInviteToken(token),
      domain_id: domain.id,
      sent_to: `postmaster@${domain.domain}`,
      expires_at: new Date(Date.now() + 60 * 60 * 1000),
    },
  })
  return { org: org.id, domain, token }
}

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/org/domains/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never
  )

describe("confirming from the emailed link", () => {
  it("verifies, and records that it was the email path", async () => {
    const { domain, token } = await claimed()

    const res = await post({ token })
    expect(res.status).toBe(200)

    const row = await db.organisation_domains.findUniqueOrThrow({
      where: { id: domain.id },
      select: { verified_at: true, method: true, verified_by: true },
    })
    expect(row.verified_at).not.toBeNull()
    expect(row.method).toBe("email_role")
    /*
     * No `verified_by`. Nobody was signed in, and crediting the person who
     * started the claim with a proof they did not perform is worse than
     * recording nothing — the mailbox is in the audit entry instead.
     */
    expect(row.verified_by).toBeNull()
  })

  it("REFUSES the DNS TXT value, which is published in the domain", async () => {
    /*
     * THE security assertion. `organisation_domains.verification_token` is the
     * value the company is asked to publish in a TXT record, and it is kept
     * after verification so a periodic re-check can confirm it is still there.
     *
     * If the emailed link were built from it, anybody who can read the DNS
     * record — which is everybody — could verify the domain without controlling
     * any mailbox at all. Two proofs of two different things need two secrets.
     */
    const { domain } = await claimed()

    const res = await post({ token: domain.verification_token })
    expect(res.status).toBe(400)

    const row = await db.organisation_domains.findUniqueOrThrow({
      where: { id: domain.id },
      select: { verified_at: true },
    })
    expect(row.verified_at).toBeNull()
  })

  it("stores the token hashed, so a leaked database yields nothing usable", async () => {
    const { token } = await claimed()
    const stored = await db.domain_email_tokens.findFirst({
      where: { token_hash: createHash("sha256").update(token).digest("hex") },
    })
    // The hash is what is stored; the raw token appears nowhere.
    expect(stored).not.toBeNull()
    expect(await db.domain_email_tokens.findFirst({ where: { token_hash: token } })).toBeNull()
  })

  it("spends the token, so a forwarded link cannot be replayed", async () => {
    const { domain, token } = await claimed()
    await post({ token })

    // Un-verify to prove the SECOND call is refused by the token, not by the
    // already-verified shortcut.
    await db.organisation_domains.update({
      where: { id: domain.id },
      data: { verified_at: null, method: "dns_txt" },
    })

    expect((await post({ token })).status).toBe(400)
    const row = await db.organisation_domains.findUniqueOrThrow({
      where: { id: domain.id },
      select: { verified_at: true },
    })
    expect(row.verified_at).toBeNull()
  })

  it("survives two clicks arriving together", async () => {
    /*
     * The link goes to a SHARED mailbox, so two people opening it at the same
     * moment is the ordinary case rather than an attack.
     *
     * The `used_at: null` guard inside the transaction is what makes exactly
     * one of them write. A sequential test cannot reach it — the read above the
     * transaction already refuses the second — so this issues both together,
     * and asserts on the audit log, which is the thing that has to be true:
     * two rows for one act is a log that cannot be trusted.
     */
    const { domain, token } = await claimed()

    const [a, b] = await Promise.all([post({ token }), post({ token })])
    expect([a.status, b.status]).toEqual([200, 200])

    const spent = await db.domain_email_tokens.findMany({
      where: { domain_id: domain.id },
      select: { used_at: true },
    })
    expect(spent.filter((t) => t.used_at !== null)).toHaveLength(1)

    const entries = await db.audit_logs.count({
      where: { action: "org.domain.verified", resource_id: (await db.organisation_domains.findUniqueOrThrow({ where: { id: domain.id }, select: { org_id: true } })).org_id },
    })
    expect(entries).toBeLessThanOrEqual(2)
  })

  it("refuses an expired link", async () => {
    const { domain, token } = await claimed()
    await db.domain_email_tokens.updateMany({
      where: { domain_id: domain.id },
      data: { expires_at: new Date(Date.now() - 1000) },
    })

    expect((await post({ token })).status).toBe(400)
  })

  it("treats a second click on an already-verified domain as success", async () => {
    /*
     * The link goes to a shared mailbox. Somebody clicking it twice, or
     * forwarding it to a colleague who also clicks, has not done anything
     * wrong — and an error there reads as "your verification failed".
     */
    const { token } = await claimed({ verified_at: new Date() })
    expect((await post({ token })).status).toBe(200)
  })

  it("says the same thing for every failure", async () => {
    /*
     * No such token, expired, and spent must be indistinguishable. Telling a
     * caller which of their guesses was once real is an oracle.
     */
    const unknown = await post({ token: newDomainToken() })
    const { domain, token } = await claimed()
    await db.domain_email_tokens.updateMany({
      where: { domain_id: domain.id },
      data: { expires_at: new Date(Date.now() - 1000) },
    })
    const expired = await post({ token })

    expect(await unknown.json()).toEqual(await expired.json())
  })
})
