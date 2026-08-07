/**
 * Two names for one deployment.
 *
 * `api.blendn.app` is a poor URL for a human to log into, so the dashboard gets
 * its own name. Both point at the same Railway service — the split is in
 * routing, not infrastructure.
 *
 * The rule has to fail *open* when unconfigured, or local development and any
 * environment without a second domain would 404 its own dashboard.
 */

function wrongHost(
  pathname: string,
  host: string | null,
  dashboardHost: string | null,
  apiHost: string | null
): boolean {
  if (!host || !dashboardHost || !apiHost) return false
  const bare = host.split(":")[0]
  if (pathname.startsWith("/dashboard")) return bare === apiHost
  if (pathname.startsWith("/api/mobile")) return bare === dashboardHost
  return false
}

const DASH = "dashboard.blendn.app"
const API = "api.blendn.app"
const check = (path: string, host: string | null) => wrongHost(path, host, DASH, API)

describe("each surface on its own host", () => {
  it("refuses a dashboard page on the API host", () => {
    expect(check("/dashboard/events", API)).toBe(true)
  })

  it("refuses a mobile endpoint on the dashboard host", () => {
    expect(check("/api/mobile/events", DASH)).toBe(true)
  })

  it("allows each on its own host", () => {
    expect(check("/dashboard/events", DASH)).toBe(false)
    expect(check("/api/mobile/events", API)).toBe(false)
  })

  it("leaves shared routes alone on both", () => {
    // /api/health, /api/leads, /login, /apply — these belong to neither surface
    // exclusively and must keep working wherever they are hit.
    for (const path of ["/api/health", "/api/leads", "/login", "/apply"]) {
      expect(check(path, DASH)).toBe(false)
      expect(check(path, API)).toBe(false)
    }
  })

  it("ignores the port", () => {
    expect(check("/dashboard/events", `${API}:8080`)).toBe(true)
  })
})

describe("fails open when unconfigured", () => {
  it("allows everything when neither host is set", () => {
    // Local development, and any environment that has not been given a second
    // domain. Getting this wrong would 404 the dashboard on localhost.
    expect(wrongHost("/dashboard/events", "localhost:3000", null, null)).toBe(false)
    expect(wrongHost("/api/mobile/events", "localhost:3000", null, null)).toBe(false)
  })

  it("allows everything when only one host is set", () => {
    // Half-configured is not a rule, it is a mistake, and enforcing half of it
    // would break one surface for no stated reason.
    expect(wrongHost("/dashboard/events", API, DASH, null)).toBe(false)
    expect(wrongHost("/api/mobile/events", DASH, null, API)).toBe(false)
  })

  it("allows everything when the host header is missing", () => {
    expect(wrongHost("/dashboard/events", null, DASH, API)).toBe(false)
  })
})
