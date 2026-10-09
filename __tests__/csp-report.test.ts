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
  expect(d["script-src"]).toEqual(["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://checkout.razorpay.com", "https://api.razorpay.com"])
  expect(d["frame-src"]).toEqual(["'self'", "https://checkout.razorpay.com", "https://api.razorpay.com"])
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
