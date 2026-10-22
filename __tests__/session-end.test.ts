/*
 * `endPhoneSessions` is half of a lock protocol (Flow 15). A refresh takes the
 * user row `FOR SHARE` before it stores a new token; this takes it `FOR NO KEY
 * UPDATE` before it does anything else, and reads its stamp only once it holds
 * it. The race itself is driven against Postgres in
 * __tests__/integration/flow15-system-codes.itest.ts; this pins the order, which
 * is what makes that true, on a transaction that records every call.
 */
jest.mock("@/lib/account-blocklist", () => ({ phonesSignedOutNow: jest.fn() }))
jest.mock("@/lib/socket-server", () => ({ evictUserSockets: jest.fn() }))

import { endPhoneSessions } from "@/lib/session-end"

const T0 = new Date("2026-10-22T10:00:00.000Z")
const LOCK_WAIT_MS = 5_000

function recordingTx(liveCount = 3) {
  const calls: string[] = []
  const updates: Record<string, unknown[]> = { user: [], tokens: [] }
  const tx = {
    // A tagged template: the row lock. Waiting for it takes five seconds of wall clock.
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      calls.push(`lock:${strings.join("?").replace(/\s+/g, " ").trim()}`)
      jest.setSystemTime(new Date(T0.getTime() + LOCK_WAIT_MS))
      return [{ "?column?": 1 }]
    }),
    user: {
      update: jest.fn(async (args: unknown) => {
        calls.push("user.update")
        updates.user.push(args)
      }),
    },
    mobile_refresh_tokens: {
      updateMany: jest.fn(async (args: unknown) => {
        calls.push("tokens.updateMany")
        updates.tokens.push(args)
        return { count: updates.tokens.length === 1 ? liveCount : 7 }
      }),
    },
    push_tokens: {
      deleteMany: jest.fn(async () => {
        calls.push("push.deleteMany")
      }),
    },
  }
  return { tx, calls, updates }
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(T0)
})
afterEach(() => jest.useRealTimers())

describe("endPhoneSessions", () => {
  it("locks the user row before it writes anything, FOR NO KEY UPDATE", async () => {
    const { tx, calls } = recordingTx()
    await endPhoneSessions(tx as never, "u1", "signout_all")

    expect(calls[0]).toMatch(/^lock:.*FROM "User" WHERE id = \?.*FOR NO KEY UPDATE$/)
    expect(calls.slice(1)).toEqual(["user.update", "tokens.updateMany", "tokens.updateMany", "push.deleteMany"])
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it("reads its stamp after the lock is held, and uses that one stamp everywhere", async () => {
    const { tx, updates } = recordingTx()
    const { at } = await endPhoneSessions(tx as never, "u1", "signout_all")

    // The lock took five seconds to get; a stamp read before it would be T0.
    expect(at.getTime()).toBe(T0.getTime() + LOCK_WAIT_MS)
    expect(updates.user[0]).toEqual({ where: { id: "u1" }, data: { mobile_sessions_revoked_at: at } })
    expect((updates.tokens[0] as { data: { revoked_at: Date } }).data.revoked_at).toBe(at)
  })

  it("stamps the reason on live rows, then on revoked-but-unexpired rows without moving their revoked_at", async () => {
    const { tx, updates } = recordingTx()
    const { at } = await endPhoneSessions(tx as never, "u1", "password_reset")

    expect(updates.tokens[0]).toEqual({
      where: { user_id: "u1", revoked_at: null },
      data: { revoked_at: at, revoked_reason: "password_reset" },
    })
    expect(updates.tokens[1]).toEqual({
      where: { user_id: "u1", revoked_at: { not: null }, revoked_reason: null, expires_at: { gt: at } },
      data: { revoked_reason: "password_reset" },
    })
  })

  it("returns how many refresh tokens were live, not how many were marked afterwards", async () => {
    const { tx } = recordingTx(2)
    expect((await endPhoneSessions(tx as never, "u1", "signout_all")).live).toBe(2)
  })

  it("takes the push tokens of this user and no other", async () => {
    const { tx } = recordingTx()
    await endPhoneSessions(tx as never, "u1", "signout_all")
    expect(tx.push_tokens.deleteMany).toHaveBeenCalledWith({ where: { user_id: "u1" } })
  })
})
