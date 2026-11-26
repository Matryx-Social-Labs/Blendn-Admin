/*
 * Where the CSP sends its reports (SCRUM-321), and (SCRUM-1243, below) where
 * it is enforced rather than only reported.
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

/**
 * The headers next.config.ts sends on a path, matched the way Next's server
 * matches them, built with `DSN` so the reporting directive is there to check.
 */
async function headersFor(nodeEnv: string, path: string): Promise<Record<string, string>> {
  const env = process.env as Record<string, string | undefined>
  const before = { NODE_ENV: env.NODE_ENV, NEXT_PUBLIC_SENTRY_DSN: env.NEXT_PUBLIC_SENTRY_DSN }
  env.NODE_ENV = nodeEnv
  env.NEXT_PUBLIC_SENTRY_DSN = DSN
  try {
    let rules: HeaderRule[] = []
    await jest.isolateModulesAsync(async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      rules = await (require("../next.config").default as { headers: () => Promise<HeaderRule[]> }).headers()
    })
    // Next's own server matcher, internal on purpose: the lookahead source is
    // only worth testing the way production evaluates it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildCustomRoute } = require("next/dist/server/lib/router-utils/filesystem")
    const sent: Record<string, string> = {}
    for (const rule of rules) {
      if (!buildCustomRoute("header", rule).match(path)) continue
      for (const h of rule.headers) sent[h.key] = h.value
    }
    return sent
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
  }
}

const ENFORCED = ["/dashboard", "/dashboard/", "/dashboard/events/abc/edit", "/dashboard/plan", "/pay", "/pay/o/tok_123", "/login", "/invite"]
// /reset-password and /forgot-password hold a token, not the session: step 2 (security/06b) decides them.
const REPORT_ONLY = ["/", "/api-docs", "/pricing", "/invite/abc", "/dashboards", "/payments", "/login-help", "/invites", "/reset-password", "/api/health"]
const reportUri = () => sentryCspReportUri(DSN, process.env.RAILWAY_ENVIRONMENT_NAME)

it.each(ENFORCED)("enforces the production policy, without 'unsafe-eval', on %s", async (path) => {
  const sent = await headersFor("production", path)
  // Exactly the library's policy, reporting to Sentry: a blocked load must show up there.
  expect(sent["Content-Security-Policy"]).toBe(contentSecurityPolicy(reportUri(), false))
  expect(sent["Content-Security-Policy"]).not.toContain("'unsafe-eval'")
  expect(sent["Content-Security-Policy"]).toContain(`report-uri ${reportUri()}`)
  expect(sent["Content-Security-Policy-Report-Only"]).toBeUndefined()
  expect(sent["X-Frame-Options"]).toBe("DENY")
})

it.each(REPORT_ONLY)("only reports on %s", async (path) => {
  const sent = await headersFor("production", path)
  expect(sent["Content-Security-Policy"]).toBeUndefined()
  expect(sent["Content-Security-Policy-Report-Only"]).toBe(contentSecurityPolicy(reportUri()))
  expect(sent["X-Frame-Options"]).toBe("DENY")
})

it("still sends no referrer, and no cache, from the pay page (its URL carries the pay token)", async () => {
  const pay = await headersFor("production", "/pay/o/tok_123")
  expect(pay["Referrer-Policy"]).toBe("no-referrer")
  expect(pay["Cache-Control"]).toBe("no-store, max-age=0")
  expect(pay["X-Robots-Tag"]).toBe("noindex, nofollow")
  expect((await headersFor("production", "/dashboard"))["Referrer-Policy"]).toBe("strict-origin-when-cross-origin")
})

it("keeps 'unsafe-eval' in development, where Next's overlay needs it", async () => {
  const sent = await headersFor("development", "/dashboard")
  expect(sent["Content-Security-Policy"]).toContain("'unsafe-eval'")
})
