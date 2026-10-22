import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"

import { cleanup, closeDb, db, makeUser, onboard } from "./helpers"

/**
 * The reasons the invite landing needs (SV10): sending a friend request, opening
 * an invite and accepting a request each say WHY in `reasonCode` when they refuse
 * for an unfinished profile or a rate limit — beside the `errorCode` installed
 * builds already match on (`FORBIDDEN`, `RATE_LIMITED`), which does not change.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const requests = require("@/app/api/mobile/friends/requests/route") as typeof import("@/app/api/mobile/friends/requests/route")
const requestById = require("@/app/api/mobile/friends/requests/[requestId]/route") as typeof import("@/app/api/mobile/friends/requests/[requestId]/route")
const invitePreview = require("@/app/api/mobile/friends/invite/[token]/route") as typeof import("@/app/api/mobile/friends/invite/[token]/route")
const friendDm = require("@/app/api/mobile/friends/[userId]/conversation/route") as typeof import("@/app/api/mobile/friends/[userId]/conversation/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
const users: string[] = []

async function person(label: string, finished = true) {
  const id = await makeUser(label)
  users.push(id)
  if (finished) await onboard(id)
  else await db.profiles.upsert({ where: { id }, create: { id, name: "Nia", onboarded: false }, update: { onboarded: false, age: null } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function call(handler: Handler, path: string, as: { token: string }, opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const res = await handler(
    new NextRequest(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json" },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    }),
    { params: Promise.resolve(opts.params ?? {}) as Promise<never> }
  )
  return { status: res.status, headers: res.headers, body: await res.json() }
}

const TOKEN = "A".repeat(22)
const send = (as: { token: string }) => call(requests.POST as Handler, "/api/mobile/friends/requests", as, { method: "POST", body: { token: TOKEN } })
const accept = (as: { token: string }) =>
  call(requestById.POST as Handler, "/api/mobile/friends/requests/00000000-0000-4000-8000-000000000000", as, {
    method: "POST",
    body: { action: "accept" },
    params: { requestId: "00000000-0000-4000-8000-000000000000" },
  })
const open = (as: { token: string }) =>
  call(invitePreview.GET as Handler, `/api/mobile/friends/invite/${TOKEN}`, as, { params: { token: TOKEN } })

afterAll(async () => {
  await cleanup(users, [])
  await closeDb()
})

describe("an unfinished profile says PROFILE_INCOMPLETE, and keeps its errorCode", () => {
  it.each([
    ["sending a request", send],
    ["accepting a request", accept],
    ["opening an invite", open],
  ])("%s", async (_name, door) => {
    const nia = await person("fsr-unfinished", false)
    const res = await door(nia)
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ success: false, errorCode: "FORBIDDEN", reasonCode: "PROFILE_INCOMPLETE" })
    expect(typeof res.body.error).toBe("string")
  })

  it("opening a friend DM too (the same gate)", async () => {
    const nia = await person("fsr-unfinished-dm", false)
    const res = await call(friendDm.POST as Handler, "/api/mobile/friends/someone/conversation", nia, { method: "POST", params: { userId: "someone" } })
    expect(res.body).toMatchObject({ errorCode: "FORBIDDEN", reasonCode: "PROFILE_INCOMPLETE" })
  })

  it("is not said to a finished profile", async () => {
    const ana = await person("fsr-finished")
    const res = await send(ana)
    expect(res.status).toBe(404) // an invite that does not exist
    expect(res.body).not.toHaveProperty("reasonCode")
  })
})

describe("a rate limit says RATE_LIMITED with retryAfter, and keeps its errorCode", () => {
  it.each([
    ["sending a request", send],
    ["accepting a request", accept],
    ["opening an invite", open],
  ])("%s", async (_name, door) => {
    const ana = await person(`fsr-rate-${_name.replace(/ /g, "")}`)
    let last = await door(ana)
    // `write` allows 30 a minute per scope: the 31st is refused.
    for (let i = 0; i < 30 && last.status !== 429; i++) last = await door(ana)
    expect(last.status).toBe(429)
    expect(last.body).toMatchObject({ success: false, errorCode: "RATE_LIMITED", reasonCode: "RATE_LIMITED" })
    expect(last.body.retryAfter).toBeGreaterThan(0)
    expect(last.headers.get("Retry-After")).toBe(String(last.body.retryAfter))
  })
})
