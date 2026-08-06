import { type NextRequest } from "next/server"

import { getAuth } from "@/lib/auth"
import { toCsv, csvResponse, UTF8_BOM, type CsvColumn } from "@/lib/csv"
import { getLeads, type LeadRow } from "@/lib/lead-queries"
import type { lead_status } from "@prisma/client"

export const dynamic = "force-dynamic"

/**
 * CSV of the current filtered view.
 *
 * Same filters as the screen, read from the same query string — an export that
 * quietly returned everything while the screen showed twelve rows would be
 * worse than no export.
 */
const columns: CsvColumn<LeadRow>[] = [
  { key: "status", label: "Status" },
  { key: "email", label: "Email" },
  { key: "name", label: "Name" },
  { key: "organization", label: "Organisation" },
  { key: "city", label: "City" },
  { key: "eventTypes", label: "Event types" },
  { key: "source", label: "Source" },
  { key: "assignedToName", label: "Assigned to" },
  { key: "submittedAt", label: "Submitted" },
  { key: "hoursWaiting", label: "Hours waiting" },
]

export async function GET(req: NextRequest) {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") {
    return new Response("Forbidden", { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const rows = await getLeads({
    status: (sp.get("status") ?? "new") as lead_status | "open" | "all",
    q: sp.get("q") ?? undefined,
    assignedTo: sp.get("assigned") ?? undefined,
  })

  // BOM so Excel reads the UTF-8 — organiser names are routinely non-ASCII.
  return csvResponse("leads.csv", UTF8_BOM + toCsv(columns, rows))
}
