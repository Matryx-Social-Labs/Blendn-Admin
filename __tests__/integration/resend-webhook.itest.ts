/*
 * The Resend webhook, through the real route, against real Postgres (SCRUM-1280,
 * launch gate 14). Bodies follow resend.com/docs/webhooks/emails/bounced and
 * /complained; signatures are Svix's (docs.svix.com/receiving/verifying-payloads/how-manual).
 * Every case reads `email_suppressions` back.
 */
import { createHmac, randomBytes, randomUUID } from "crypto"
import { NextRequest } from "next/server"

import { closeDb, db } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("@/app/api/webhooks/resend/route") as typeof import("@/app/api/webhooks/resend/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const KEY = randomBytes(24)
const SECRET = `whsec_${KEY.toString("base64")}`
const addresses: string[] = []

/** An address no other run or case uses, removed after. */
function address(label: string) {
  const a = `itest-${label}-${randomUUID().slice(0, 8)}@resend.dev`
  addresses.push(a)
  return a
}

beforeAll(() => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET
})

afterAll(async () => {
  delete process.env.RESEND_WEBHOOK_SECRET
  await db.email_suppressions.deleteMany({ where: { email: { in: addresses } } })
  await closeDb()
})

const bounced = (to: string, type = "Permanent") => ({
  type: "email.bounced",
  created_at: new Date().toISOString(),
  data: {
    created_at: new Date().toISOString(),
    email_id: randomUUID(),
    from: "Blend'n <hello@blendn.app>",
    to: [to],
    subject: "Reset your password",
    bounce: { message: "The recipient's email address does not exist.", subType: "General", type },
  },
})

const complained = (to: string) => ({
  type: "email.complained",
  created_at: new Date().toISOString(),
  data: { created_at: new Date().toISOString(), email_id: randomUUID(), from: "hello@blendn.app", to: [to], subject: "s" },
})

function signed(raw: string, o: { id?: string; at?: number; key?: Buffer } = {}) {
  const id = o.id ?? `msg_${randomUUID()}`
  const ts = String(Math.floor((o.at ?? Date.now()) / 1000))
  const sig = createHmac("sha256", o.key ?? KEY).update(`${id}.${ts}.${raw}`).digest("base64")
  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` }
}

async function post(raw: string, headers: Record<string, string>, ip = "203.0.113.30") {
  const res = await route.POST(
    new NextRequest("http://localhost/api/webhooks/resend", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip, ...headers },
      body: raw,
    })
  )
  return res.status
}

const rows = (email: string) => db.email_suppressions.findMany({ where: { email }, select: { email: true, reason: true } })

describe("refused: writes nothing and never answers 2xx", () => {
  it("a bad signature is 401", async () => {
    const to = address("badsig")
    const raw = JSON.stringify(bounced(to))
    expect(await post(raw, signed(raw, { key: randomBytes(24) }))).toBe(401)
    expect(await rows(to)).toEqual([])
  })

  it("no signature at all is 401", async () => {
    const to = address("unsigned")
    expect(await post(JSON.stringify(bounced(to)), {})).toBe(401)
    expect(await rows(to)).toEqual([])
  })

  it("a body changed after signing is 401", async () => {
    const to = address("tampered")
    const raw = JSON.stringify(bounced(address("original")))
    expect(await post(JSON.stringify(bounced(to)), signed(raw))).toBe(401)
    expect(await rows(to)).toEqual([])
  })

  it.each([
    ["six minutes old", -6 * 60_000],
    ["six minutes ahead", 6 * 60_000],
  ])("a signature %s is 401: outside Svix's five-minute tolerance", async (_label, skew) => {
    const to = address("stale")
    const raw = JSON.stringify(bounced(to))
    expect(await post(raw, signed(raw, { at: Date.now() + skew }))).toBe(401)
    expect(await rows(to)).toEqual([])
  })

  it("with RESEND_WEBHOOK_SECRET unset, even a well-signed delivery is 401", async () => {
    const to = address("unset")
    const raw = JSON.stringify(bounced(to))
    delete process.env.RESEND_WEBHOOK_SECRET
    try {
      expect(await post(raw, signed(raw))).toBe(401)
    } finally {
      process.env.RESEND_WEBHOOK_SECRET = SECRET
    }
    expect(await rows(to)).toEqual([])
  })

  it("a network that keeps failing the signature is rate-limited (429), in the route", async () => {
    const raw = JSON.stringify(bounced(address("flood")))
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) statuses.push(await post(raw, {}, "198.51.100.77"))
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true)
    expect(statuses[30]).toBe(429)
  })
})

describe("accepted", () => {
  it("a signed hard bounce writes one bounce row, by the address as sign-in stores it", async () => {
    const to = address("hard")
    const raw = JSON.stringify(bounced(`  ${to.toUpperCase()} `))
    expect(await post(raw, signed(raw))).toBe(200)
    expect(await rows(to)).toEqual([{ email: to, reason: "bounce" }])
  })

  it.each(["Transient", "Undetermined"])("a signed %s (soft) bounce writes nothing, and is still 200", async (type) => {
    const to = address("soft")
    const raw = JSON.stringify(bounced(to, type))
    expect(await post(raw, signed(raw))).toBe(200)
    expect(await rows(to)).toEqual([])
  })

  it("a signed complaint writes one complaint row", async () => {
    const to = address("complaint")
    const raw = JSON.stringify(complained(to))
    expect(await post(raw, signed(raw))).toBe(200)
    expect(await rows(to)).toEqual([{ email: to, reason: "complaint" }])
  })

  it("a replay upserts and stays one row", async () => {
    const to = address("replay")
    const raw = JSON.stringify(bounced(to))
    const headers = signed(raw)
    expect(await post(raw, headers)).toBe(200)
    expect(await post(raw, headers)).toBe(200)
    expect(await post(raw, signed(raw))).toBe(200)
    expect(await rows(to)).toEqual([{ email: to, reason: "bounce" }])
  })

  it("a hard bounce outranks an earlier complaint (it also stops the reset); a later complaint does not undo it", async () => {
    const to = address("rank")
    for (const body of [complained(to), bounced(to), complained(to)]) {
      const raw = JSON.stringify(body)
      expect(await post(raw, signed(raw))).toBe(200)
    }
    expect(await rows(to)).toEqual([{ email: to, reason: "bounce" }])
  })

  it("a bounce or complaint replaces an unsubscribe", async () => {
    const to = address("unsub")
    await db.email_suppressions.create({ data: { email: to, reason: "unsubscribe" } })
    const raw = JSON.stringify(complained(to))
    expect(await post(raw, signed(raw))).toBe(200)
    expect(await rows(to)).toEqual([{ email: to, reason: "complaint" }])
  })

  it("another event type is 200 and writes nothing", async () => {
    const to = address("delivered")
    const raw = JSON.stringify({ ...complained(to), type: "email.delivered" })
    expect(await post(raw, signed(raw))).toBe(200)
    expect(await rows(to)).toEqual([])
  })

  it("the database refuses a reason it does not know", async () => {
    await expect(
      db.email_suppressions.create({ data: { email: address("check"), reason: "spam" } })
    ).rejects.toThrow()
  })
})
