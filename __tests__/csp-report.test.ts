/*
 * Where the report-only CSP sends its reports (SCRUM-321).
 *
 * The policy was report-only with no reporting directive, so it neither
 * blocked nor collected — and its own plan to become enforcing needed a week of
 * reports first. Sentry takes CSP reports at an endpoint derived from the DSN
 * the app already has, so no route of ours has to accept, bound and store
 * anonymous POSTs.
 */
import { sentryCspReportUri } from "@/lib/csp-report"

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
