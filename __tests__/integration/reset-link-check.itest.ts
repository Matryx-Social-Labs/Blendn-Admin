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

const check = async (token: string) => {
  const res = await route.GET(
    new NextRequest(`http://localhost/api/auth/reset-password?token=${encodeURIComponent(token)}`)
  )
  return { status: res.status, body: await res.json() }
}

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

  const answers = await Promise.all([used, expired, tampered, ""].map(check))

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
