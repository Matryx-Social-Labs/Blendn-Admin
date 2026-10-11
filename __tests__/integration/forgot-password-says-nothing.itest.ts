/**
 * /api/auth/forgot-password says the same thing, in the same time, whatever
 * the address (step 18 security review, L3).
 *
 * It waited for the mail before answering, so an address with an account took
 * a send longer than one without; and its per-address limit answered a 429 —
 * three requests from a stranger and the owner's own was refused for the hour.
 * Now the cap stops mail and nothing else, over it nothing is issued (so the
 * newest mailed link stays good), its window is fixed, and its key is the
 * hash of the same string the account is looked up by.
 */
let mailDelayMs = 0
const sent: Array<{ to: string; text: string }> = []
jest.mock("@/lib/email", () => ({
  ...jest.requireActual("@/lib/email"),
  emailConfigured: () => true,
  sendEmail: jest.fn(async (m: { to: string; text: string }) => {
    if (mailDelayMs) await new Promise((r) => setTimeout(r, mailDelayMs))
    sent.push(m)
    return { sent: true }
  }),
}))

import { NextRequest } from "next/server"

import { POST } from "@/app/api/auth/forgot-password/route"
import { POST as resetPassword } from "@/app/api/auth/reset-password/route"
import { resetMemoryStore } from "@/lib/rate-limit-store"

import { closeDb, db, makeUser, testId } from "./helpers"

const users: string[] = []
let ip = 0

afterAll(async () => {
  await db.password_reset_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

beforeEach(() => {
  sent.length = 0
  mailDelayMs = 0
  resetMemoryStore()
})

const settled = () => new Promise((r) => setTimeout(r, 50))

const ask = (email: string, from = `198.51.100.${++ip % 250}`) =>
  POST(
    new NextRequest("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": from },
      body: JSON.stringify({ email }),
    })
  )

async function answer(res: Response) {
  return { status: res.status, body: await res.text() }
}

async function account() {
  const id = await makeUser("l3_host", "organizer")
  users.push(id)
  const email = `l3-${testId("x").toLowerCase()}@toit.in`
  await db.user.update({ where: { id }, data: { email } })
  return email
}

it("answers an account, no account, and a malformed address alike", async () => {
  const email = await account()
  const real = await answer(await ask(email))
  expect(real.status).toBe(200)
  expect(await answer(await ask(`l3-nobody-${testId("x").toLowerCase()}@toit.in`))).toEqual(real)
  expect(await answer(await ask("not an address"))).toEqual(real)
})

it("takes no less time for an address with no account", async () => {
  const t0 = Date.now()
  await ask(`l3-nobody-${testId("x").toLowerCase()}@toit.in`)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(550)
})

it("never waits for the mail", async () => {
  mailDelayMs = 1_500
  const email = await account()
  const t0 = Date.now()
  expect((await ask(email)).status).toBe(200)
  expect(Date.now() - t0).toBeLessThan(1_200)
  // Lands after the answer — and before the next test, which counts mail.
  while (sent.length === 0) await settled()
  expect(sent[0].to).toBe(email)
})

it("past the cap, the same answer, no mail, and no new token", async () => {
  const email = await account()
  const first = await answer(await ask(email, "203.0.113.31"))
  await ask(email, "203.0.113.31")
  await ask(email, "203.0.113.31")
  await settled()
  expect(sent).toHaveLength(3)
  const user = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
  const issued = await db.password_reset_tokens.count({ where: { user_id: user.id } })

  expect(await answer(await ask(email, "203.0.113.31"))).toEqual(first)
  await settled()
  expect(sent).toHaveLength(3)
  expect(await db.password_reset_tokens.count({ where: { user_id: user.id } })).toBe(issued)
})

/** The link in a reset mail, as the owner would click it. */
const linkIn = (text: string) => new URL(/https?:\/\/\S+reset-password\?token=\S+/.exec(text)![0]).searchParams.get("token")!

it("a stranger who spends the cap leaves the owner a link that works", async () => {
  const email = await account()
  for (let i = 0; i < 3; i++) await ask(email, `203.0.113.${40 + i}`)
  await settled()
  const newest = sent.at(-1)!
  expect(newest.to).toBe(email)

  // The owner asks too, and is answered the same; nothing is sent or spent.
  expect((await ask(email, "203.0.113.50")).status).toBe(200)
  await settled()
  expect(sent).toHaveLength(3)

  const res = await resetPassword(
    new NextRequest("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.50" },
      body: JSON.stringify({ token: linkIn(newest.text), password: "Juniper-Harbour-Lantern-58" }),
    })
  )
  expect(res.status).toBe(200)
})

it("case and whitespace variants are one address: one account, one cap", async () => {
  const email = await account()
  const variants = [email, `  ${email.toUpperCase()}  `, `${email[0].toUpperCase()}${email.slice(1)}\t`]
  for (const v of variants) await ask(v, `203.0.113.${60 + variants.indexOf(v)}`)
  await settled()
  expect(sent.map((m) => m.to)).toEqual([email, email, email])

  await ask(` ${email.toUpperCase()}`, "203.0.113.64")
  await settled()
  expect(sent).toHaveLength(3)
})

it("the cap's window is fixed: requests inside it do not hold it shut", async () => {
  const email = await account()
  const realNow = Date.now.bind(Date)
  let offset = 0
  const clock = jest.spyOn(Date, "now").mockImplementation(() => realNow() + offset)
  try {
    for (let i = 0; i < 3; i++) await ask(email, `203.0.113.${70 + i}`)
    offset = 30 * 60_000
    await ask(email, "203.0.113.73")
    offset = 61 * 60_000
    await settled()
    sent.length = 0
    await ask(email, "203.0.113.74")
    await settled()
    expect(sent.map((m) => m.to)).toEqual([email])
  } finally {
    clock.mockRestore()
  }
})
