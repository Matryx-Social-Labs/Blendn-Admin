/*
 * Where the report-only CSP sends its reports (SCRUM-321).
 *
 * The policy was report-only with no reporting directive, so it neither
 * blocked nor collected — and its own plan to become enforcing needed a week of
 * reports first. Sentry takes CSP reports at an endpoint derived from the DSN
 * the app already has, so no route of ours has to accept, bound and store
 * anonymous POSTs.
 */
import { contentSecurityPolicy, RAZORPAY_CHECKOUT_ORIGINS, sentryCspReportUri } from "@/lib/csp-report"

const DSN = "https://abc123publickey@o4511350417588224.ingest.us.sentry.io/4512058262159360"

it("derives Sentry's security endpoint from the DSN", () => {
  expect(sentryCspReportUri(DSN)).toBe(
    "https://o4511350417588224.ingest.us.sentry.io/api/4512058262159360/security/?sentry_key=abc123publickey"
  )
})

it("tags the environment when there is one", () => {
  expect(sentryCspReportUri(DSN, "staging")).toBe(
    "https://o4511350417588224.ingest.us.sentry.io/api/4512058262159360/security/?sentry_key=abc123publickey&sentry_environment=staging"
  )
})

it("reports nowhere, rather than somewhere wrong, without a usable DSN", () => {
  expect(sentryCspReportUri(undefined)).toBeNull()
  expect(sentryCspReportUri("")).toBeNull()
  expect(sentryCspReportUri("not a url")).toBeNull()
  expect(sentryCspReportUri("https://o1.ingest.sentry.io/123")).toBeNull() // no key
  expect(sentryCspReportUri("https://key@o1.ingest.sentry.io/")).toBeNull() // no project
})

/*
 * F12 / MN-E04 at the unit level (G12): the exact token sets, so a widening
 * fails as surely as a narrowing, and the header next.config.ts really sends
 * is this function's output, not a copy that could drift.
 */
const directives = (policy: string) =>
  Object.fromEntries(
    policy.split("; ").map((d) => {
      const [name, ...values] = d.split(" ")
      return [name, values]
    })
  )

it("lets Razorpay Checkout load its script and open its frames, and loosens nothing else", () => {
  const d = directives(contentSecurityPolicy(null))
  // cdn.razorpay.com: checkout.js adds its risk-detection script to our page
  // from there (SCRUM-608, the one violation on staging). A script, never a frame.
  expect(d["script-src"]).toEqual([
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "https://checkout.razorpay.com",
    "https://api.razorpay.com",
    "https://cdn.razorpay.com",
  ])
  expect(d["frame-src"]).toEqual(["'self'", "https://checkout.razorpay.com", "https://api.razorpay.com"])
  // Its images (cdn.razorpay.com) and beacons (lumberjack.razorpay.com) are already https.
  expect(d["img-src"]).toEqual(["'self'", "data:", "blob:", "https:"])
  // The event form's video previews: the picked file (blob:), then the
  // uploaded clip on Tigris. The only CSP reports Sentry ever had (staging,
  // 2026-11-25, BLENDN-ADMIN-M and -N).
  expect(d["media-src"]).toEqual(["'self'", "blob:", "https://*.fly.storage.tigris.dev"])
  expect(d["connect-src"]).toEqual(["'self'", "https:", "wss:"])
  expect(d["frame-ancestors"]).toEqual(["'none'"])
  expect(d["default-src"]).toEqual(["'self'"])
  expect(d["form-action"]).toEqual(["'self'"])
  expect(RAZORPAY_CHECKOUT_ORIGINS).toEqual(["https://checkout.razorpay.com", "https://api.razorpay.com"])
  expect(d["report-uri"]).toBeUndefined()
})

it("is the header next.config.ts sends", async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require("../next.config").default as { headers: () => Promise<{ headers: { key: string; value: string }[] }[]> }
  const sent = (await config.headers()).flatMap((h) => h.headers).find((h) => h.key === "Content-Security-Policy-Report-Only")
  expect(sent?.value).toBe(
    contentSecurityPolicy(sentryCspReportUri(process.env.NEXT_PUBLIC_SENTRY_DSN, process.env.RAILWAY_ENVIRONMENT_NAME))
  )
})

/*
 * SCRUM-1243: enforcing on the pages that hold the session cookie or load
 * Razorpay. Production gets no 'unsafe-eval' (only Next's dev overlay needs
 * it); everything else stays report-only, Swagger at /api-docs included.
 */
it("drops 'unsafe-eval' when eval is not allowed, and keeps the rest", () => {
  const reportUri = sentryCspReportUri(DSN, "production")
  const d = directives(contentSecurityPolicy(reportUri, false))
  expect(d["script-src"]).toEqual([
    "'self'",
    "'unsafe-inline'",
    "https://checkout.razorpay.com",
    "https://api.razorpay.com",
    "https://cdn.razorpay.com",
  ])
  expect(d["frame-src"]).toEqual(["'self'", "https://checkout.razorpay.com", "https://api.razorpay.com"])
  expect(d["report-uri"]).toEqual([reportUri])
  expect(contentSecurityPolicy(reportUri, false)).toBe(contentSecurityPolicy(reportUri).replace(" 'unsafe-eval'", ""))
})

type HeaderRule = { source: string; headers: { key: string; value: string }[] }

/** The headers next.config.ts sends on a path, matched the way Next's server matches them. */
async function headersFor(nodeEnv: string, path: string): Promise<Record<string, string>> {
  const env = process.env as Record<string, string | undefined>
  const before = env.NODE_ENV
  env.NODE_ENV = nodeEnv
  try {
    let rules: HeaderRule[] = []
    await jest.isolateModulesAsync(async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      rules = await (require("../next.config").default as { headers: () => Promise<HeaderRule[]> }).headers()
    })
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildCustomRoute } = require("next/dist/server/lib/router-utils/filesystem")
    const sent: Record<string, string> = {}
    for (const rule of rules) {
      if (!buildCustomRoute("header", rule).match(path)) continue
      for (const h of rule.headers) sent[h.key] = h.value
    }
    return sent
  } finally {
    env.NODE_ENV = before
  }
}

const ENFORCED = ["/dashboard", "/dashboard/events/abc/edit", "/dashboard/plan", "/pay/o/tok_123", "/login"]
const REPORT_ONLY = ["/", "/api-docs", "/pricing", "/invite/abc", "/dashboards", "/payments", "/login-help", "/api/health"]

it.each(ENFORCED)("enforces the production policy, without 'unsafe-eval', on %s", async (path) => {
  const sent = await headersFor("production", path)
  expect(sent["Content-Security-Policy"]).toBeDefined()
  expect(sent["Content-Security-Policy"]).not.toContain("'unsafe-eval'")
  expect(sent["Content-Security-Policy"]).toContain("https://checkout.razorpay.com")
  expect(sent["Content-Security-Policy-Report-Only"]).toBeUndefined()
})

it.each(REPORT_ONLY)("only reports on %s", async (path) => {
  const sent = await headersFor("production", path)
  expect(sent["Content-Security-Policy"]).toBeUndefined()
  expect(sent["Content-Security-Policy-Report-Only"]).toContain("'unsafe-eval'")
})

it("keeps 'unsafe-eval' in development, where Next's overlay needs it", async () => {
  const sent = await headersFor("development", "/dashboard")
  expect(sent["Content-Security-Policy"]).toContain("'unsafe-eval'")
})
