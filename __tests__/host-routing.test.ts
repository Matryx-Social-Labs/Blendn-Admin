/**
 * Two names for one deployment.
 *
 * `api.blendn.app` is a poor URL for a human to log into, so the dashboard gets
 * its own name. Both point at the same Railway service — the split is routing,
 * not infrastructure.
 *
 * The asymmetry is the point. A person on the wrong host followed a link, very
 * possibly one of our own lead-notification emails, which deep-link to
 * `NEXTAUTH_URL` and have already been sent — 404ing them would break every
 * mail in every inbox the day this is switched on. A mobile client on the
 * dashboard host is misconfigured, and a redirect would hide that.
 *
 * And it must fail OPEN when unconfigured, or localhost 404s its own dashboard.
 */

type HostVerdict = { kind: "ok" } | { kind: "redirect"; host: string } | { kind: "reject" }

function checkHost(
  pathname: string,
  host: string | null,
  dashboardHost: string | null,
  apiHost: string | null
): HostVerdict {
  if (!host || !dashboardHost || !apiHost) return { kind: "ok" }
  const bare = host.split(":")[0]
  if (pathname.startsWith("/dashboard") || pathname === "/login" || pathname === "/") {
    return bare === apiHost ? { kind: "redirect", host: dashboardHost } : { kind: "ok" }
  }
  if (pathname.startsWith("/api/mobile")) {
    return bare === dashboardHost ? { kind: "reject" } : { kind: "ok" }
  }
  return { kind: "ok" }
}

const DASH = "dashboard.blendn.app"
const API = "api.blendn.app"
const check = (path: string, host: string | null) => checkHost(path, host, DASH, API)

describe("humans are redirected", () => {
  it("moves a dashboard page off the API host", () => {
    expect(check("/dashboard/events", API)).toEqual({ kind: "redirect", host: DASH })
  })

  it("moves an already-sent lead notification link", () => {
    // These emails deep-link to NEXTAUTH_URL and are in inboxes now. A 404 here
    // would break every one of them.
    expect(check("/dashboard/leads", API)).toEqual({ kind: "redirect", host: DASH })
  })

  it("moves /login too", () => {
    // Signing in on the API host would land you on a dashboard not served there.
    expect(check("/login", API)).toEqual({ kind: "redirect", host: DASH })
  })

  it("moves the root, which is now the dashboard's front door", () => {
    // There is no page at `/` any more — the marketing site is blendn.app, and
    // this deployment sends `/` straight to the login. Left on the API host it
    // would redirect to /login and only then change host: two hops for the most
    // common way anyone arrives.
    expect(check("/", API)).toEqual({ kind: "redirect", host: DASH })
  })

  it("leaves them alone on the dashboard host", () => {
    expect(check("/dashboard/events", DASH)).toEqual({ kind: "ok" })
    expect(check("/login", DASH)).toEqual({ kind: "ok" })
  })
})

describe("misconfigured clients are rejected", () => {
  it("404s a mobile endpoint on the dashboard host", () => {
    // Nothing linked it there. Redirecting would hide the misconfiguration.
    expect(check("/api/mobile/events", DASH)).toEqual({ kind: "reject" })
  })

  it("allows the mobile API on its own host", () => {
    expect(check("/api/mobile/events", API)).toEqual({ kind: "ok" })
  })
})

describe("shared routes serve on both", () => {
  it("leaves everything neither surface owns alone", () => {
    // /api/leads is called server-to-server by the landing page and must not
    // move; /api/health is what Railway polls. `/` is deliberately absent — it
    // belongs to the dashboard now.
    for (const path of ["/api/health", "/api/leads", "/api/geocode", "/apply"]) {
      expect(check(path, DASH)).toEqual({ kind: "ok" })
      expect(check(path, API)).toEqual({ kind: "ok" })
    }
  })
})

describe("fails open when unconfigured", () => {
  it("allows everything when neither host is set", () => {
    // Local development, and any environment without a second domain. Getting
    // this backwards would 404 the dashboard on localhost.
    expect(checkHost("/dashboard/events", "localhost:3000", null, null)).toEqual({ kind: "ok" })
    expect(checkHost("/api/mobile/events", "localhost:3000", null, null)).toEqual({ kind: "ok" })
  })

  it("allows everything when only one host is set", () => {
    // Half-configured is a mistake, not a policy.
    expect(checkHost("/dashboard/events", API, DASH, null)).toEqual({ kind: "ok" })
    expect(checkHost("/api/mobile/events", DASH, null, API)).toEqual({ kind: "ok" })
  })

  it("allows everything when the host header is missing", () => {
    expect(checkHost("/dashboard/events", null, DASH, API)).toEqual({ kind: "ok" })
  })
})

describe("ports are ignored", () => {
  it("matches the hostname regardless of port", () => {
    expect(check("/dashboard/events", `${API}:8080`)).toEqual({ kind: "redirect", host: DASH })
  })
})
