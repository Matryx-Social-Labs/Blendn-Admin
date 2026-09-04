import { NextRequest } from "next/server"
import { errorResponse } from "@/lib/api-response"
import { getAuth } from "@/lib/auth"
import { logger } from "@/lib/logger"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { auditLog } from "@/lib/audit-log"
import { resolveRange } from "@/lib/date-range"
import { csvResponse, reportFilename } from "@/lib/csv"
import { buildReport, canRunReport, type ReportKey } from "@/lib/reports"

/**
 * Download a report as CSV.
 *
 * A GET rather than a server action because the browser has to receive it as a
 * file — an action returns a value to JavaScript, and turning that back into a
 * download means building a blob and a synthetic anchor click for no gain.
 *
 * Every run is audited. An export is a bulk read of operational data, and "who
 * pulled the attendee list, and when" is exactly the question an audit log
 * exists to answer.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await getAuth()
    if (!session?.user) return errorResponse("Unauthorized", 401)

    const { key } = await params

    // Authorization is the report's own declaration, not a check written here —
    // a report added later cannot forget to gate itself.
    if (!canRunReport(key, session.user.role)) {
      return errorResponse("Forbidden", 403)
    }

    // Generating a report is a full table scan with joins. Ten a minute is far
    // more than a person needs and well under what would hurt.
    const limited = await rateLimit(req, userLimit("heavy", "reports", session.user.id))
    if (limited) return limited

    const url = new URL(req.url)
    const range = resolveRange({
      range: url.searchParams.get("range") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    })

    const csv = await buildReport(key as ReportKey, session.user.role, session.user.id, range)

    auditLog({
      userId: session.user.id,
      action: "report.exported",
      resource: "report",
      resourceId: key,
      details: { from: range.from.toISOString(), to: range.to.toISOString(), rows: csv.split("\r\n").length - 1 },
    })

    return csvResponse(reportFilename(key, range.from, range.to), csv)
  } catch (err) {
    logger.error("Report export failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return errorResponse("Could not build that report.", 500)
  }
}
