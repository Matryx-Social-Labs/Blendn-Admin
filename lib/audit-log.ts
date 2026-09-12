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
        /*
         * Conditional spread, not `?? undefined`. With `strictUndefinedChecks`
         * on, an explicit undefined here made every audit write WITHOUT
         * details throw — `signout`, among others — and the catch below
         * logged it and moved on, so the accountability record had holes
         * nobody was told about. Seen in the dev log as "Audit log write
         * failed"; the ratchet had missed it because this call is split
         * across a newline.
         */
        ...(entry.details !== undefined && { details: entry.details }),
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
