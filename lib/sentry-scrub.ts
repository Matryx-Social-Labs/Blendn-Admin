import type { ErrorEvent, EventHint } from "@sentry/nextjs"

/**
 * Shared Sentry `beforeSend` and `ignoreErrors` for all three runtimes.
 *
 * Blendn's error context routinely carries user identifiers, email addresses,
 * and JWTs (auth routes, chat handlers, presigned upload URLs). None of that
 * needs to leave the server to make an error actionable, and once it reaches
 * Sentry it is out of our retention control.
 */

/** Query/body keys whose values are replaced wholesale. */
const SENSITIVE_KEYS = [
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "authorization",
  "cookie",
  "secret",
  "apiKey",
  "email",
  "phone",
]

const REDACTED = "[redacted]"

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g
// JWTs and long opaque credentials in URLs or messages.
const JWT_RE = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g
// Presigned URL signatures leak the request credential.
const PRESIGN_RE = /([?&])(X-Amz-Signature|X-Amz-Credential|Signature)=[^&\s]+/gi

export function scrubString(value: string): string {
  return value
    .replace(EMAIL_RE, REDACTED)
    .replace(JWT_RE, REDACTED)
    .replace(PRESIGN_RE, `$1$2=${REDACTED}`)
}

function scrubRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (SENSITIVE_KEYS.some((k) => key.toLowerCase().includes(k.toLowerCase()))) {
      out[key] = REDACTED
    } else if (typeof value === "string") {
      out[key] = scrubString(value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Errors that are expected, user-caused, or otherwise not worth a Sentry event.
 * These burn quota and bury real regressions.
 */
export const IGNORED_ERRORS = [
  // Navigation aborts — a user leaving a page mid-request is not a bug.
  "AbortError",
  "The operation was aborted",
  "NEXT_REDIRECT",
  "NEXT_NOT_FOUND",
  // Offline / flaky mobile networks.
  "Failed to fetch",
  "NetworkError when attempting to fetch resource",
  "Load failed",
  // Expected auth outcomes, already surfaced to the user as a 401.
  "Invalid or expired token",
  "jwt expired",
  // Browser extension noise on the dashboard.
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop limit exceeded",
]

export function beforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  // Identify the account without shipping who they are.
  if (event.user) {
    event.user = { id: event.user.id }
  }

  if (event.request) {
    delete event.request.cookies
    if (event.request.headers) {
      event.request.headers = scrubRecord(
        event.request.headers as unknown as Record<string, unknown>
      ) as Record<string, string>
    }
    if (typeof event.request.url === "string") {
      event.request.url = scrubString(event.request.url)
    }
    if (event.request.query_string && typeof event.request.query_string === "string") {
      event.request.query_string = scrubString(event.request.query_string)
    }
    // Request bodies are the most likely place for credentials and message text.
    delete event.request.data
  }

  if (event.extra) event.extra = scrubRecord(event.extra)
  if (event.tags) {
    event.tags = scrubRecord(event.tags as Record<string, unknown>) as typeof event.tags
  }

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubString(exception.value)
  }

  if (event.message) event.message = scrubString(event.message)

  return event
}
