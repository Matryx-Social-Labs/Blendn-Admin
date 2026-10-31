/**
 * /apply says the same thing to every address (step 18 security review, M4).
 *
 * It answered an address that already had a host account with a 409 and
 * "This email already has a Blend'n host account" — an oracle for who
 * operates on Blend'n. Now:
 *
 *   - the response is a new application's: the same status, the same body
 *     field for field (an id that names nothing), the same minimum time, and
 *     neither branch waits for its email;
 *   - the email to an existing address is a fixed text with nothing the
 *     request typed in it, sent to the address we hold, at most once a day
 *     per address whoever asks;
 *   - nothing is queued twice.
 */
let mailDelayMs = 0
const sent: Array<{ to: string; subject: string; text: string; html?: string }> = []
jest.mock("@/lib/email", () => ({
  ...jest.requireActual("@/lib/email"),
  emailConfigured: () => true,
  sendEmail: jest.fn(async (m: { to: string; subject: string; text: string; html?: string }) => {
    if (mailDelayMs) await new Promise((r) => setTimeout(r, mailDelayMs))
    sent.push(m)
    return { sent: true }
  }),
}))

import { NextRequest } from "next/server"

import { headerSafe } from "@/lib/email"
import { POST } from "@/app/api/onboarding/apply/route"
import { resetMemoryStore } from "@/lib/rate-limit-store"

import { closeDb, db, makeUser, testId } from "./helpers"

const users: string[] = []
let n = 0

afterAll(async () => {
  const ids = (await db.organiser_onboarding_requests.findMany({ where: { contact_email: { startsWith: "m4-" } }, select: { id: true } })).map((r) => r.id)
  await db.onboarding_email_tokens.deleteMany({ where: { request_id: { in: ids } } })
  await db.organiser_onboarding_requests.deleteMany({ where: { id: { in: ids } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

beforeEach(() => {
  sent.length = 0
  mailDelayMs = 0
  resetMemoryStore()
})

/** Wait for the sends that happen after the response. */
const settled = () => new Promise((r) => setTimeout(r, 50))

const INJECTED_NAME = "Mallory\r\nBcc: victim@example.com <b>urgent</b>"
const INJECTED_ORG = "Totally Legit Ltd — click https://evil.example"

const apply = (email: string) =>
  POST(
    new NextRequest("http://localhost/api/onboarding/apply", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": `198.51.100.${++n}` },
      body: JSON.stringify({
        kind: "company",
        requested_role: "organizer",
        display_name: INJECTED_ORG,
        legal_name: "M4 Events Pvt Ltd",
        contact_name: INJECTED_NAME,
        contact_email: email,
      }),
    })
  )

/** A response with its id taken out: everything else must be byte-identical. */
async function withoutId(res: Response) {
  const body = (await res.json()) as Record<string, unknown>
  expect(typeof body.requestId).toBe("string")
  return { status: res.status, body: JSON.stringify({ ...body, requestId: "<id>" }) }
}

async function hostAddress() {
  const host = await makeUser("m4_host", "organizer")
  users.push(host)
  const email = `m4-host-${testId("x").toLowerCase()}@toit.in`
  await db.user.update({ where: { id: host }, data: { email } })
  return email
}

it("answers an address with a host account exactly as a new one", async () => {
  const fresh = await withoutId(await apply(`m4-new-${testId("x").toLowerCase()}@toit.in`))
  const hostEmail = await hostAddress()
  const res = await apply(hostEmail)
  const body = (await res.clone().json()) as { requestId: string }
  expect(await withoutId(res)).toEqual(fresh)
  // An id that names nothing, and nothing queued.
  expect(await db.organiser_onboarding_requests.count({ where: { id: body.requestId } })).toBe(0)
  expect(await db.organiser_onboarding_requests.count({ where: { contact_email: hostEmail } })).toBe(0)
})

it("emails the existing address a fixed text with nothing the request typed in it", async () => {
  const hostEmail = await hostAddress()
  await apply(hostEmail)
  await settled()
  expect(sent).toHaveLength(1)
  const mail = sent[0]
  expect(mail).toMatchObject({ to: hostEmail, subject: "You already have a Blend’n host account" })
  const everything = `${mail.subject}\n${mail.text}\n${mail.html ?? ""}`
  for (const typed of ["Mallory", "Bcc", "victim@example.com", "urgent", "Totally Legit", "evil.example", "M4 Events"]) {
    expect(everything).not.toContain(typed)
  }
  expect(mail.text).toContain("/login")
})

it("sends that email at most once a day per address, whoever asks", async () => {
  const hostEmail = await hostAddress()
  await apply(hostEmail)
  await apply(hostEmail)
  await apply(hostEmail)
  await settled()
  expect(sent.filter((m) => m.to === hostEmail)).toHaveLength(1)
})

it("answers an address that already applied the same way, queues nothing new, and says so once", async () => {
  const email = `m4-again-${testId("x").toLowerCase()}@toit.in`
  const first = await withoutId(await apply(email))
  await settled()
  sent.length = 0

  expect(await withoutId(await apply(email))).toEqual(first)
  await settled()
  expect(await db.organiser_onboarding_requests.count({ where: { contact_email: email } })).toBe(1)
  expect(sent).toHaveLength(1)
  expect(sent[0].subject).toBe("We already have your Blend’n application")
})

it("never waits for the mail, on either branch", async () => {
  mailDelayMs = 4_000
  const hostEmail = await hostAddress()
  for (const email of [`m4-slow-${testId("x").toLowerCase()}@toit.in`, hostEmail]) {
    const t0 = Date.now()
    expect((await apply(email)).status).toBe(200)
    expect(Date.now() - t0).toBeLessThan(2_500)
  }
})

it("keeps a header on one line", () => {
  expect(headerSafe("About you\r\nBcc: x@y.z")).toBe("About you Bcc: x@y.z")
  expect(headerSafe("a b")).toBe("a b")
})

describe("an application whose name mixes lookalike scripts (SCRUM-959)", () => {
  it("is refused when it is submitted, with a 400 and no row", async () => {
    const email = `m4-${testId("ms")}@example.test`
    const res = await POST(
      new NextRequest("http://localhost/api/onboarding/apply", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": `198.51.100.${++n}` },
        body: JSON.stringify({ kind: "company", requested_role: "organizer", display_name: "Th\u0456rd Wave Events", legal_name: "M4 Events Pvt Ltd", contact_name: "Pat", contact_email: email }),
      })
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/one alphabet/i)
    expect(await db.organiser_onboarding_requests.count({ where: { contact_email: email } })).toBe(0)
  })
})
