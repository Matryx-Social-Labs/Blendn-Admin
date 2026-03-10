type LogLevel = "debug" | "info" | "warn" | "error"

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const MIN_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL as LogLevel) || "info"]

interface LogEntry {
  level: LogLevel
  message: string
  timestamp: string
  [key: string]: unknown
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= MIN_LEVEL
}

function formatEntry(level: LogLevel, message: string, meta?: Record<string, unknown>): LogEntry {
  return {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...meta,
  }
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (!shouldLog(level)) return

  const entry = formatEntry(level, message, meta)

  if (process.env.NODE_ENV === "production") {
    // Structured JSON in production
    const output = JSON.stringify(entry)
    if (level === "error") {
      console.error(output)
    } else if (level === "warn") {
      console.warn(output)
    } else {
      console.log(output)
    }
  } else {
    // Human-readable in development
    const prefix = `[${level.toUpperCase()}]`
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : ""
    if (level === "error") {
      console.error(`${prefix} ${message}${metaStr}`)
    } else if (level === "warn") {
      console.warn(`${prefix} ${message}${metaStr}`)
    } else {
      console.log(`${prefix} ${message}${metaStr}`)
    }
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
}
