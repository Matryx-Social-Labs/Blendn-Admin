/**
 * Where the report-only Content-Security-Policy sends its reports (SCRUM-321).
 *
 * Sentry's security endpoint, derived from the DSN the app already reports
 * errors to: `https://<key>@<host>/<project>` →
 * `https://<host>/api/<project>/security/?sentry_key=<key>`. The key is the
 * public one — the DSN is `NEXT_PUBLIC_` already. Using Sentry means no route
 * of ours accepts, bounds and stores anonymous POSTs.
 *
 * Null without a usable DSN: a policy that reports nowhere is what shipped
 * before, and better than one pointing at a malformed URL.
 *
 * Relative imports only — `next.config.ts` loads this before the path alias
 * exists.
 */
export function sentryCspReportUri(dsn: string | undefined, environment?: string): string | null {
  if (!dsn) return null
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    return null
  }
  const project = url.pathname.replace(/^\/+|\/+$/g, "")
  if (!url.username || !project) return null

  const endpoint = `${url.protocol}//${url.host}/api/${project}/security/?sentry_key=${url.username}`
  return environment ? `${endpoint}&sentry_environment=${encodeURIComponent(environment)}` : endpoint
}

/**
 * Razorpay Checkout's origins (plan v2 §9.2, test plan F12 / MN-E04): its
 * script, and the frames it opens its payment sheet in. `connect-src` already
 * allows any https origin, which covers its telemetry.
 */
export const RAZORPAY_CHECKOUT_ORIGINS = ["https://checkout.razorpay.com", "https://api.razorpay.com"] as const

/**
 * The policy itself, as a header value. Here rather than inline in
 * `next.config.ts` so a test can read the real thing.
 */
export function contentSecurityPolicy(reportUri: string | null): string {
  const razorpay = RAZORPAY_CHECKOUT_ORIGINS.join(" ")
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${razorpay}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss:",
    `frame-src 'self' ${razorpay}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(reportUri ? [`report-uri ${reportUri}`] : []),
  ].join("; ")
}
