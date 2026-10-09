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
 * F12 / MN-E04 at the unit level: Checkout loads a script from
 * checkout.razorpay.com and opens its payment sheet in a frame. With no
 * `frame-src`, `default-src 'self'` would block the frame the moment the
 * policy enforces, and report it until then.
 */
it("lets Razorpay Checkout load its script and open its frames", () => {
  const directives = Object.fromEntries(
    contentSecurityPolicy(null)
      .split("; ")
      .map((d) => {
        const [name, ...values] = d.split(" ")
        return [name, values]
      })
  )
  for (const origin of RAZORPAY_CHECKOUT_ORIGINS) {
    expect(directives["script-src"]).toContain(origin)
    expect(directives["frame-src"]).toContain(origin)
  }
  expect(RAZORPAY_CHECKOUT_ORIGINS).toContain("https://checkout.razorpay.com")
  // Nothing else is loosened: the page itself still may not be framed.
  expect(directives["frame-ancestors"]).toEqual(["'none'"])
  expect(directives["default-src"]).toEqual(["'self'"])
})
