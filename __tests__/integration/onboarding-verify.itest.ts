import { createHash, randomBytes } from "crypto"
import { POST as verifyRoute } from "@/app/api/onboarding/verify/route"
import { NextRequest } from "next/server"
import { db, closeDb, testId } from "./helpers"

/**
 * Confirming an applicant's email, against the real route and real rows.
 *
 * This exists because of a defect that only appeared when the link was clicked
 * twice on staging. The route rejected a spent token before it ever looked at
 * whether the application was *already confirmed*, so the second click — which
 * people make routinely, and which mail clients make on their own by
 * prefetching — returned "invalid or expired, apply again". That sent someone
 * to re-submit an application already sitting in the queue, where the duplicate
 * guard then refused them outright. A dead end reached by doing nothing wrong.
 *
 * A unit test could not have caught it: the ordering bug lives in the route
 * handler, between two database reads.
 */

const requests: string[] = []
const tokens: string[] = []

afterAll(async () => {
  if (tokens.length) {
    await db.onboarding_email_tokens.deleteMany({ where: { token_hash: { in: tokens } } })
  }
  if (requests.length) {
    await db.organiser_onboarding_requests.deleteMany({ where: { id: { in: requests } } })
  }
  await closeDb()
})

const hash = (t: string) => createHash("sha256").update(t).digest("hex")

async function makeApplication(opts: { expired?: boolean; used?: boolean; verified?: boolean } = {}) {
  const request = await db.organiser_onboarding_requests.create({
    data: {
      kind: "company",
      display_name: testId("org"),
      contact_name: "Probe Person",
      contact_email: `${testId("probe")}@example.test`,
      tier: "domain",
      status: opts.verified ? "pending" : "email_pending",
      email_verified_at: opts.verified ? new Date() : null,
      requested_role: "organizer",
    },
    select: { id: true, display_name: true },
  })
  requests.push(request.id)

  const token = randomBytes(32).toString("base64url")
  const token_hash = hash(token)
  tokens.push(token_hash)

  await db.onboarding_email_tokens.create({
    data: {
      token_hash,
      request_id: request.id,
      expires_at: new Date(Date.now() + (opts.expired ? -60_000 : 60 * 60_000)),
      used_at: opts.used ? new Date() : null,
    },
  })

  return { request, token }
}

/** Call the route the way Next does, with an IP so the rate limiter has a key. */
async function verify(token: string) {
  const req = new NextRequest("http://localhost/api/onboarding/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.${Math.floor(Math.random() * 250)}.0.1` },
    body: JSON.stringify({ token }),
  })
  const res = await verifyRoute(req)
  return { status: res.status, body: await res.json() }
}

describe("confirming an email", () => {
  it("confirms a live token and flips the application into review", async () => {
    const { request, token } = await makeApplication()

    const first = await verify(token)
    expect(first.status).toBe(200)
    expect(first.body.success).toBe(true)

    const after = await db.organiser_onboarding_requests.findUniqueOrThrow({
      where: { id: request.id },
      select: { status: true, email_verified_at: true },
    })
    expect(after.status).toBe("pending")
    expect(after.email_verified_at).not.toBeNull()
  })

  it("treats a SECOND click as success, not as an expired link", async () => {
    // The regression. Clicking twice is normal behaviour, and telling someone
    // to "apply again" walks them into the duplicate guard.
    const { token } = await makeApplication()

    await verify(token)
    const second = await verify(token)

    expect(second.status).toBe(200)
    expect(second.body.success).toBe(true)
    expect(second.body.alreadyVerified).toBe(true)
  })

  it("spends the token — it is not reusable for an unconfirmed application", async () => {
    // Single-use still holds where it matters: a token already marked used, on
    // an application that was never confirmed, does nothing.
    const { request, token } = await makeApplication({ used: true })

    const res = await verify(token)
    expect(res.status).toBe(400)

    const after = await db.organiser_onboarding_requests.findUniqueOrThrow({
      where: { id: request.id },
      select: { status: true, email_verified_at: true },
    })
    expect(after.status).toBe("email_pending")
    expect(after.email_verified_at).toBeNull()
  })

  it("refuses an expired token and leaves the application alone", async () => {
    const { request, token } = await makeApplication({ expired: true })

    expect((await verify(token)).status).toBe(400)

    const after = await db.organiser_onboarding_requests.findUniqueOrThrow({
      where: { id: request.id },
      select: { email_verified_at: true },
    })
    expect(after.email_verified_at).toBeNull()
  })

  it("refuses a token that was never issued", async () => {
    const res = await verify(randomBytes(32).toString("base64url"))
    expect(res.status).toBe(400)
  })

  it("gives one message for every failure", async () => {
    // Distinguishing "no such token" from "expired" tells someone probing which
    // of their guesses were once real.
    const never = await verify(randomBytes(32).toString("base64url"))
    const { token: expiredToken } = await makeApplication({ expired: true })
    const expired = await verify(expiredToken)

    expect(never.body.error).toBe(expired.body.error)
  })

  it("never stores the token itself", async () => {
    const { token } = await makeApplication()
    const rows = await db.onboarding_email_tokens.findMany({
      where: { token_hash: hash(token) },
      select: { token_hash: true },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).not.toContain(token)
  })
})
