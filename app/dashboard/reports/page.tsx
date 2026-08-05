import { redirect } from "next/navigation"

import { getAuth } from "@/lib/auth"
import { reportsFor } from "@/lib/reports"
import { resolveRange, rangeLabel } from "@/lib/date-range"

import { ReportBuilder } from "./builder"

export const dynamic = "force-dynamic"

/**
 * Reports and export.
 *
 * The login page has always sold this — *"Exportable reporting: download
 * platform, organiser, and venue reports directly from the dashboard"* — and
 * nothing in the product exported anything. It was the most visible of the
 * three promises this redesign found the product unable to keep.
 *
 * CSV only. PDF was in the design and is deliberately not here: a PDF report
 * needs a rendering pipeline and a layout per report, and the thing people
 * actually do with an export is open it in a spreadsheet. Adding PDF later is
 * additive; shipping a worse CSV to get one sooner is not.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>
}) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  const range = resolveRange(await searchParams)
  const available = reportsFor(session.user.role)

  return (
    <ReportBuilder
      reports={available}
      rangeLabel={rangeLabel(range)}
      query={new URLSearchParams(
        Object.entries(await searchParams).filter(([, v]) => v) as [string, string][]
      ).toString()}
    />
  )
}
