import { NextRequest } from "next/server"

import { hashInviteToken, newInviteToken } from "@/lib/org-invites"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/*
 * A reset link says whether it still works before anyone types a password
 * (SCRUM-461).
 *
 * Driven on staging: a used link, and a tampered one, opened the "choose a new
 * password" form as if nothing were wrong. The person typed a password twice
 * and only then learned the link was dead. The page now asks first, through a
 * GET that answers the same yes/no the reset itself enforces, and consumes
 * nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("@/app/api/auth/reset-password/route") as typeof import("@/app/api/auth/reset-password/route")

const users: string[] = []

afterAll(async () => {
  await db.password_reset_tokens.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

async function tokenFor(userId: string, opts: { usedAt?: Date; expiresAt?: Date } = {}) {
  const raw = newInviteToken()
  await db.password_reset_tokens.create({
    data: {
      token_hash: hashInviteToken(raw),
      user_id: userId,
      expires_at: opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      used_at: opts.usedAt ?? null,
    },
  })
  return raw
}

// One address per call unless a test says otherwise; the second octet is per run.
const net = `10.${Math.floor(Math.random() * 200) + 50}`
let n = 0
const nextIp = () => `${net}.1.${++n}`

const check = async (token: string, ip = nextIp()) => {
  const res = await route.GET(
    new NextRequest(`http://localhost/api/auth/reset-password?token=${encodeURIComponent(token)}`, {
      headers: { "x-real-ip": ip },
    })
  )
  return { status: res.status, body: await res.json() }
}

const reset = (token: string, password: string, ip = nextIp()) =>
  route.POST(
    new NextRequest("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: JSON.stringify({ token, password }),
    })
  )

it("says a fresh link works, and leaves it unused", async () => {
  const user = await makeUser(testId("reset-ok"))
  users.push(user)
  const raw = await tokenFor(user)

  expect(await check(raw)).toEqual({ status: 200, body: { valid: true } })
  const row = await db.password_reset_tokens.findUniqueOrThrow({ where: { token_hash: hashInviteToken(raw) } })
  expect(row.used_at).toBeNull()
})

it("says a used, expired or tampered link does not, all in the same words", async () => {
  const user = await makeUser(testId("reset-dead"))
  users.push(user)
  const used = await tokenFor(user, { usedAt: new Date() })
  const expired = await tokenFor(user, { expiresAt: new Date(Date.now() - 1000) })
  const live = await tokenFor(user)
  const tampered = live.slice(0, -1) + (live.endsWith("a") ? "b" : "a")

  const answers = await Promise.all([used, expired, tampered, ""].map((t) => check(t)))

  // One answer for every dead link: which kind of dead is not the caller's business.
  expect(answers.map((a) => a.body)).toEqual([{ valid: false }, { valid: false }, { valid: false }, { valid: false }])
})

it("says a link for an erased account does not work", async () => {
  const user = await makeUser(testId("reset-gone"))
  users.push(user)
  const raw = await tokenFor(user)
  await db.user.update({ where: { id: user }, data: { deletedAt: new Date() } })

  expect((await check(raw)).body).toEqual({ valid: false })
})

it("refuses to reset through an expired link or an erased account's link, and changes no password", async () => {
  // The reset asks the same question as the check, so neither can drift from the other.
  const user = await makeUser(testId("reset-post"))
  users.push(user)
  const before = await db.user.findUniqueOrThrow({ where: { id: user }, select: { password: true } })
  const expired = await tokenFor(user, { expiresAt: new Date(Date.now() - 1000) })

  expect((await reset(expired, "orchard-lantern-quiet-42")).status).toBe(400)

  const live = await tokenFor(user)
  await db.user.update({ where: { id: user }, data: { deletedAt: new Date() } })
  expect((await reset(live, "orchard-lantern-quiet-42")).status).toBe(400)

  const after = await db.user.findUniqueOrThrow({ where: { id: user }, select: { password: true } })
  expect(after.password).toBe(before.password)
})

it("limits the check on its own bucket, so opening the page never spends a reset attempt", async () => {
  const ip = nextIp()
  const answers = []
  for (let i = 0; i < 31; i++) answers.push((await check("no-such-token", ip)).status)

  expect(answers.slice(0, 30).every((s) => s === 200)).toBe(true)
  expect(answers[30]).toBe(429)
  // The reset from the same address is still answered on its merits, not limited.
  expect((await reset("no-such-token", "orchard-lantern-quiet-42", ip)).status).toBe(400)
})
