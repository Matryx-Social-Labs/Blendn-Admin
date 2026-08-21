import { readFileSync } from "fs"
import { join } from "path"

import {
  SUSPENSION_WRITE_CHANNELS,
  SUSPENSION_READ_GATES,
} from "@/lib/suspension"

/**
 * R14: the enforcement blast radius is enumerated, and the list is the test.
 *
 * Suspension was the clearest case of a safety control that reported success
 * while doing nothing. The transaction wrote `suspended_at`, revoked mobile
 * refresh tokens, and called `session.deleteMany()` — a no-op, because the
 * strategy is `jwt` and there are no `Session` rows. Meanwhile the reviewer's
 * UI said it "blocks the account everywhere and signs it out".
 *
 * So a suspended person kept a valid dashboard cookie for up to thirty days,
 * kept an open socket, stayed a member of every room, and kept receiving
 * pushes — and the moderator who suspended them had been told otherwise.
 *
 * The failure is not that somebody wrote the wrong query. It is that
 * "everywhere" was a word in a sentence rather than a list anybody could check.
 * These tests make it a list.
 *
 * When a new user-reachable channel ships — the board, a second realtime
 * surface, anything that lets somebody act — add it to the constant in
 * `lib/suspension.ts` and wire it in the same PR. This test is what makes
 * forgetting expensive now rather than later.
 */
const ROOT = join(__dirname, "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

const SUSPENSION = () => stripComments(read("lib/suspension.ts"))

describe("every write channel is actually written", () => {
  /*
   * Comments are stripped first. The whole point of this file is that a
   * channel named in prose and not in code is the bug — a test that accepted a
   * mention would reproduce it.
   */
  const src = SUSPENSION()

  it("covers exactly the channels the constant lists", () => {
    expect([...SUSPENSION_WRITE_CHANNELS]).toEqual([
      "user.suspended_at",
      "mobile_refresh_tokens",
      "push_tokens",
      "chat_group_members",
    ])
  })

  it("writes suspended_at", () => {
    expect(src).toMatch(/suspended_at:\s*new Date\(\)/)
  })

  it("revokes mobile refresh tokens", () => {
    expect(src).toMatch(/mobile_refresh_tokens\.updateMany/)
    expect(src).toMatch(/revoked_at/)
  })

  it("removes push tokens", () => {
    // A suspended account that keeps receiving notifications is still being
    // told about a room it cannot enter.
    expect(src).toMatch(/push_tokens\.deleteMany/)
  })

  it("bans chat membership rather than leaving it active", () => {
    expect(src).toMatch(/chat_group_members\.updateMany/)
    expect(src).toMatch(/status:\s*"banned"/)
  })

  it("does not call session.deleteMany, which is a no-op under the jwt strategy", () => {
    expect(src).not.toContain("session.deleteMany")
    expect(stripComments(read("app/dashboard/moderation/reports/actions.ts"))).not.toContain(
      "session.deleteMany"
    )
  })
})

describe("every read gate consults it", () => {
  for (const gate of SUSPENSION_READ_GATES) {
    it(`${gate.file} checks suspension — ${gate.what}`, () => {
      /*
       * Four gates, and each one alone is insufficient. Blocking sign-in stops
       * the next session, not the live one. Re-reading in the jwt callback ends
       * the cookie but not an open socket. The socket handshake covers realtime
       * and nothing else. They only add up to "everywhere" together.
       */
      const src = stripComments(read(gate.file))
      expect(src).toMatch(/suspended_at|accountBlockReason/)
    })
  }
})

describe("lib/auth.ts holds two gates, and both are asserted separately", () => {
  /*
   * A negative control caught this file's first draft being too loose: it
   * asserted that `lib/auth.ts` mentions suspension somewhere, so reverting the
   * jwt-callback half left it green. That half is the one that ends a *live*
   * session — blocking `authorize()` only stops the next sign-in, and with the
   * jwt strategy there is no session table to clear, so an existing cookie
   * would have stayed valid for up to thirty days.
   *
   * One file, two independent gates, two assertions.
   */
  const AUTH = () => stripComments(read("lib/auth.ts"))

  it("authorize() refuses a suspended or deleted account", () => {
    const authorizeBody = /async authorize\([\s\S]*?\n      \},/.exec(AUTH())
    expect(authorizeBody).not.toBeNull()
    expect(authorizeBody![0]).toMatch(/suspended_at/)
    expect(authorizeBody![0]).toMatch(/deletedAt/)
  })

  it("the jwt callback re-reads suspension, so a live cookie dies", () => {
    const jwtBody = /async jwt\([\s\S]*?\n    \},/.exec(AUTH())
    expect(jwtBody).not.toBeNull()
    // Selected...
    expect(jwtBody![0]).toMatch(/select:[^}]*suspended_at/)
    // ...and actually consulted, not just fetched.
    expect(jwtBody![0]).toMatch(/suspended_at\s*!==\s*null|suspended_at\s*\?|suspended_at\s*\)/)
  })
})

describe("the suspend action goes through the one implementation", () => {
  const actions = () => stripComments(read("app/dashboard/moderation/reports/actions.ts"))

  it("calls applySuspension rather than writing the channels inline", () => {
    /*
     * Four inline statements is how one of them came to be a no-op nobody
     * noticed. One call site means the next channel lands in one place.
     */
    expect(actions()).toMatch(/applySuspension\(/)
    expect(actions()).toMatch(/liftSuspension\(/)
  })

  it("does not write suspended_at directly", () => {
    expect(actions()).not.toMatch(/suspended_at:\s*new Date\(\)/)
  })
})

describe("the reviewer is told what suspension actually does", () => {
  it("no longer claims it signs them out of everything", () => {
    /*
     * The old copy said "blocks the account everywhere and signs it out" while
     * doing neither. A moderator reading that believed they had acted. Copy
     * that overstates a safety control is part of the control failing.
     */
    const copy = read("app/dashboard/moderation/reports/reports-table.tsx")
    expect(copy).not.toContain("blocks the account everywhere and signs it out")
    expect(copy).toMatch(/suspending blocks sign-in/)
  })
})
