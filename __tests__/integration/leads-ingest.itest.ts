import { NextRequest } from "next/server"

import { openKeyFor } from "@/lib/leads"

import { db, closeDb } from "./helpers"

/**
 * The acceptance checklist from the contract, executed against real Postgres.
 *
 * This is the **first test in the repo that invokes an API route handler**.
 * Every other DB-touching test mocks `@/lib/db`, which is why a boundary bug
 * could reach production undetected — the suite could not tell the difference
 * between a route that works and a route that throws.
 *
 * It also exercises the `open_key` unique index and the status transitions that
 * maintain it — an invariant no mock can check, because a mock has no unique
 * index to violate.
 */

const TOKEN = "itest-token-0123456789abcdef0123456789ab"

// The route reads process.env at call time, and `db` here shares DATABASE_URL
// with the handler's own client, so both see the same rows.
process.env.LANDING_INGEST_TOKEN = TOKEN
// Unset so `notifyNewLead` short-circuits — the assertions are about storage.
delete process.env.LEADS_NOTIFY_EMAIL

// Imported after the env is set.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { POST } = require("@/app/api/leads/route") as typeof import("@/app/api/leads/route")

const emails: string[] = []

function post(body: unknown, token: string | null = TOKEN) {
  return POST(
    new NextRequest("http://localhost/api/leads", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  )
}

/** Unique per test so the per-email rate limit never bleeds between them. */
function freshEmail(label: string) {
  const email = `itest_${label}_${Math.random().toString(36).slice(2, 10)}@example.com`
  emails.push(email)
  return email
}

function lead(email: string, extra: Record<string, unknown> = {}) {
  return {
    type: "demo_request",
    source: "organizers-landing",
    email,
    submittedAt: new Date().toISOString(),
    ...extra,
  }
}

afterAll(async () => {
  if (emails.length) {
    await db.lead_notes.deleteMany({ where: { lead: { email: { in: emails } } } })
    await db.leads.deleteMany({ where: { email: { in: emails } } })
  }
  await closeDb()
})

describe("POST /api/leads", () => {
  it("stores a valid lead and returns 201 with its id", async () => {
    const email = freshEmail("ok")
    const res = await post(lead(email, { name: "Sam Rivera", city: "Bengaluru" }))
    expect(res.status).toBe(201)

    const json = await res.json()
    expect(json.duplicate).toBe(false)

    const row = await db.leads.findUnique({ where: { id: json.id } })
    expect(row).not.toBeNull()
    expect(row!.status).toBe("new")
    expect(row!.email).toBe(email)
    expect(row!.name).toBe("Sam Rivera")
  })

  it("returns 201 then 409, and creates exactly one row", async () => {
    // The double-tap case. The `open_key` unique index enforces it, so a mock
    // could not catch a schema that shipped without the constraint.
    const email = freshEmail("dup")
    const first = await post(lead(email))
    const second = await post(lead(email))

    expect(first.status).toBe(201)
    expect(second.status).toBe(409)

    // Read once — a Response body cannot be consumed twice.
    const firstBody = await first.json()
    const secondBody = await second.json()
    expect(secondBody.duplicate).toBe(true)
    // The 409 carries the existing id, so the caller can log which lead it hit
    // rather than just knowing "something was already there".
    expect(secondBody.id).toBe(firstBody.id)

    expect(await db.leads.count({ where: { email } })).toBe(1)
  })

  it("lets a returning request through once the earlier lead is closed", async () => {
    // The reason idempotency is scoped to open leads. A permanent unique key
    // would show this visitor success and store nothing.
    const email = freshEmail("returning")
    const first = await post(lead(email))
    const firstId = (await first.json()).id

    // Through the same rule production uses. An earlier version of this test
    // set `status` alone and failed — correctly: `open_key` is what enforces
    // idempotency, and a status change that does not carry it is a bug in the
    // caller, not in the schema.
    await db.leads.update({
      where: { id: firstId },
      data: { status: "converted", open_key: openKeyFor("converted", "demo_request", email) },
    })

    const second = await post(lead(email))
    expect(second.status).toBe(201)
    expect(await db.leads.count({ where: { email } })).toBe(2)
  })

  it("rejects a bad token with 401 and stores nothing", async () => {
    const email = freshEmail("badtoken")
    const res = await post(lead(email), "wrong-token")
    expect(res.status).toBe(401)
    expect(await db.leads.count({ where: { email } })).toBe(0)
  })

  it("rejects a missing token with 401 and stores nothing", async () => {
    const email = freshEmail("notoken")
    const res = await post(lead(email), null)
    expect(res.status).toBe(401)
    expect(await db.leads.count({ where: { email } })).toBe(0)
  })

  it("rejects an invalid email with 400 and stores nothing", async () => {
    const res = await post(lead("not-an-email"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("validation_failed")
    expect(await db.leads.count({ where: { email: "not-an-email" } })).toBe(0)
  })

  it("rejects a malformed body with 400 rather than 500", async () => {
    const res = await post("{not json")
    expect(res.status).toBe(400)
  })

  it("ignores unknown extra fields", async () => {
    // So the landing page can add a field without a coordinated deploy.
    const email = freshEmail("extra")
    const res = await post(lead(email, { referrer: "twitter", utm_source: "x" }))
    expect(res.status).toBe(201)
  })

  it("stores a bad ip as null rather than failing the lead", async () => {
    // Postgres INET would reject it outright and lose the lead to a 500.
    const email = freshEmail("badip")
    const res = await post(lead(email, { ip: "not-an-ip" }))
    expect(res.status).toBe(201)
    const row = await db.leads.findUnique({ where: { id: (await res.json()).id } })
    expect(row!.ip).toBeNull()
  })

  it("records submitted_at separately from created_at", async () => {
    // The gap between them is the only evidence of a retry or an outage.
    const submittedAt = new Date(Date.now() - 60_000).toISOString()
    const email = freshEmail("times")
    const res = await post(lead(email, { submittedAt }))
    const row = await db.leads.findUnique({ where: { id: (await res.json()).id } })
    expect(row!.submitted_at.toISOString()).toBe(submittedAt)
    expect(row!.created_at.getTime()).toBeGreaterThan(row!.submitted_at.getTime())
  })

  it("stores the plus-stripped root alongside the address as given", async () => {
    const email = freshEmail("plus").replace("@", "+promo@")
    emails.push(email)
    const res = await post(lead(email))
    expect(res.status).toBe(201)
    const row = await db.leads.findUnique({ where: { id: (await res.json()).id } })
    // Contact uses the real address; only the counter uses the root.
    expect(row!.email).toBe(email)
    expect(row!.email_root).not.toContain("+promo")
  })
})
