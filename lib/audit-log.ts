import { logger } from "./logger"
import { db } from "./db"
import { Prisma } from "@prisma/client"

interface AuditLogEntry {
  userId?: string
  action: string
  resource: string
  resourceId?: string
  details?: Prisma.InputJsonValue
  ipAddress?: string
}

/**
 * Log a sensitive operation for audit purposes.
 * Fire-and-forget — does not throw on failure.
 */
export function auditLog(entry: AuditLogEntry): void {
  db.audit_logs
    .create({
      data: {
        user_id: entry.userId ?? null,
        action: entry.action,
        resource: entry.resource,
        resource_id: entry.resourceId ?? null,
        details: entry.details ?? undefined,
        ip_address: entry.ipAddress ?? null,
      },
    })
    .catch((err) => {
      logger.error("Audit log write failed", { error: String(err) })
    })
}

/**
 * Extract IP address from request headers
 */
export function getRequestIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  )
}
