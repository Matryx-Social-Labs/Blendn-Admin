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
