import { captureException, captureMessage } from "@sentry/nextjs"

type LogLevel = "debug" | "info" | "warn" | "error"

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const MIN_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL as LogLevel) || "info"]

function write(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  // Not `<`: an unknown LOG_LEVEL leaves MIN_LEVEL undefined, and then nothing logs.
  if (!(LOG_LEVELS[level] >= MIN_LEVEL)) return
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log
  out(
    process.env.NODE_ENV === "production"
      ? // Structured JSON in production
        JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...meta })
      : // Human-readable in development
        `[${level.toUpperCase()}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`
  )
}

/**
 * An error line also goes to Sentry (SCRUM-1397): the alert rules only see what
 * reaches it, and a handled failure (a push, a sweep, a mail) used to live in
 * Railway's log window alone. One issue per log message, not per id inside it;
 * the shared `beforeSend` (lib/sentry-scrub.ts) scrubs the extras.
 *
 * The custom server's copy of this file (dist/server.js) reaches the client
 * that instrumentation.ts initialised inside Next's bundle: the SDK keeps it on
 * `globalThis.__SENTRY__`, not in module state (__tests__/logger-sentry.test.ts).
 */
function report(message: string, meta?: Record<string, unknown>, tags?: Record<string, string>) {
  try {
    const key = meta && Object.keys(meta).find((k) => meta[k] instanceof Error)
    const context = { level: "error" as const, fingerprint: [message], tags }
    if (meta && key) {
      // The issue title becomes the exception's text, so the log message rides along.
      const { [key]: err, ...rest } = meta
      captureException(err, { ...context, extra: { log: message, ...rest } })
    } else {
      captureMessage(message, { ...context, extra: meta })
    }
  } catch (err) {
    // Never into the caller, and never through logger.error (that would report again).
    console.error("Sentry report failed", err instanceof Error ? err.message : String(err))
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  /** `tags` are Sentry tags, for a call site that splits its issues (push receipts by code and platform). */
  error: (message: string, meta?: Record<string, unknown>, tags?: Record<string, string>) => {
    write("error", message, meta)
    report(message, meta, tags)
  },
}
