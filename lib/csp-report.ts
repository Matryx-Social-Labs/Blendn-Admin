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
 * script, and the frames it opens its payment sheet in. `connect-src` and
 * `img-src` already allow any https origin, which covers its telemetry
 * (lumberjack.razorpay.com) and its app icons.
 */
export const RAZORPAY_CHECKOUT_ORIGINS = ["https://checkout.razorpay.com", "https://api.razorpay.com"] as const
/**
 * Where checkout.js loads its risk-detection script into our page from
 * (`/static/cx/razorpay-risk-detection/bundle.js`, SCRUM-608). A script
 * only: nothing there is framed.
 */
export const RAZORPAY_SCRIPT_CDN = "https://cdn.razorpay.com"

/**
 * Where the event form's video previews play from: the picked file (`blob:`),
 * then the uploaded clip at its public Tigris URL (`getPublicUrl` in
 * lib/tigris.ts). Any bucket, so the header does not depend on a build-time
 * `TIGRIS_BUCKET`. These were the only CSP reports Sentry ever received
 * (staging, 2026-11-25).
 */
const TIGRIS_MEDIA_ORIGIN = "https://*.fly.storage.tigris.dev"

/**
 * The policy itself, as a header value. Here rather than inline in
 * `next.config.ts` so a test can read the real thing.
 *
 * `allowEval` is false for the enforcing copy in production (SCRUM-1243):
 * only Next's dev overlay and Swagger UI need `'unsafe-eval'`, and Swagger
 * stays report-only. `'unsafe-inline'` stays until the per-request nonce
 * (security/06b).
 */
export function contentSecurityPolicy(reportUri: string | null, allowEval = true): string {
  const razorpay = RAZORPAY_CHECKOUT_ORIGINS.join(" ")
  const evalSource = allowEval ? " 'unsafe-eval'" : ""
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${evalSource} ${razorpay} ${RAZORPAY_SCRIPT_CDN}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    `media-src 'self' blob: ${TIGRIS_MEDIA_ORIGIN}`,
    "font-src 'self' data:",
    "connect-src 'self' https: wss:",
    `frame-src 'self' ${razorpay}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(reportUri ? [`report-uri ${reportUri}`] : []),
  ].join("; ")
}
