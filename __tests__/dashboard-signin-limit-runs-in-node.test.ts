import { readFileSync } from "fs"
import { join } from "path"

/*
 * The dashboard sign-in limit runs in the Node runtime (SCRUM-194), inside
 * authorize() (lib/auth.ts), not in front of the NextAuth route.
 *
 * Driven on staging: seven wrong passwords showed the lockout sentence, then
 * six more POSTs from the same network went 302 302 429 302 302 302 — the
 * limiter lived in the Edge middleware, where Redis cannot load. It moved to
 * the route, matching `pathname === "/api/auth/callback/credentials"`, and a
 * percent-encoded `%63redentials` reached the same handler unlimited (audit
 * 2026-10-24, WEB H1). The behaviour is pinned in dashboard-signin-limits.test.ts;
 * this pins where it must NOT live again.
 */
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8")

describe("where the sign-in limit does not live", () => {
  it("the NextAuth route does not match on the request path", () => {
    const src = read("app/api/auth/[...nextauth]/route.ts")
    expect(src).not.toMatch(/pathname/)
    expect(src).not.toMatch(/callback\/credentials/)
  })

  it("the middleware no longer carries the limiter — the Edge runtime is where it silently stopped working", () => {
    const src = read("middleware.ts")
    expect(src).not.toMatch(/dashboard-signin/)
    expect(src).not.toMatch(/callback\/credentials/)
  })
})

describe("where it does", () => {
  it("authorize() limits per network and per email before it reads the password", () => {
    const src = read("lib/auth.ts")
    expect(src).toMatch(/refuseOverSigninLimits\(keys, knownDevice\)/)
    expect(src.indexOf("refuseOverSigninLimits(keys, knownDevice)")).toBeLessThan(src.indexOf("bcrypt.compare"))
    expect(src).toMatch(/settleSigninSuccess\(keys, knownDevice\)/)
  })

  it("a completed password reset clears the email's sign-in counters", () => {
    const src = read("app/api/auth/reset-password/route.ts")
    expect(src).toMatch(/clearSigninCounters\(row\.user\.email\)/)
    expect(src.indexOf("await clearSigninCounters")).toBeGreaterThan(src.indexOf("endPhoneSessions(tx"))
  })
})
