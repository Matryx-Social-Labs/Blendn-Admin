import { dashboardUrl } from "@/lib/email"

/*
 * Where the app's "Claim it" link points (step 1): the dashboard host, never
 * the API host. `NEXTAUTH_URL` has pointed at the API host before, so the
 * split's own variable wins when it is set.
 */
describe("dashboardUrl", () => {
  const saved = { host: process.env.DASHBOARD_HOST, auth: process.env.NEXTAUTH_URL }
  afterEach(() => {
    process.env.DASHBOARD_HOST = saved.host
    process.env.NEXTAUTH_URL = saved.auth
    if (saved.host === undefined) delete process.env.DASHBOARD_HOST
    if (saved.auth === undefined) delete process.env.NEXTAUTH_URL
  })

  it("is the dashboard host over https when the host split is on", () => {
    process.env.DASHBOARD_HOST = "staging-dashboard.blendn.app"
    process.env.NEXTAUTH_URL = "https://staging-api.blendn.app"
    expect(dashboardUrl()).toBe("https://staging-dashboard.blendn.app")
  })

  it("is plain http for a local split, which has no certificate", () => {
    process.env.DASHBOARD_HOST = "localhost:3100"
    expect(dashboardUrl()).toBe("http://localhost:3100")
  })

  it("falls back to NEXTAUTH_URL when there is no split", () => {
    process.env.DASHBOARD_HOST = " "
    process.env.NEXTAUTH_URL = "http://localhost:3107/"
    expect(dashboardUrl()).toBe("http://localhost:3107")
  })
})
