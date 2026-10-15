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

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
}
