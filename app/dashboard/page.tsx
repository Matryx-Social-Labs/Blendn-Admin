import { getAuth } from "@/lib/auth"
import type { DashboardRole } from "@/lib/dashboard-types"
import { ReportOverview } from "@/components/dashboard/report-overview"

import { getDashboardReport } from "./actions"

export const dynamic = "force-dynamic"

export default async function Page() {
  const session = await getAuth()
  const role = session?.user?.role as DashboardRole
  const userId = role === "app_admin" ? undefined : session?.user?.id
  const report = await getDashboardReport(role, userId)

  return <ReportOverview report={report} />
}
