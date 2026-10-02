"use client"

import { useState } from "react"
import { refusalText } from "@/lib/refusal"
import { IconDownload, IconFileSpreadsheet } from "@tabler/icons-react"
import { toast } from "sonner"

import { Row } from "@/components/dashboard/kit"
import { Button } from "@/components/ui/button"
import type { ReportDef } from "@/lib/reports"

/**
 * Every report this role may take, one row each with its own CSV button (the
 * kit's Reports, step 15).
 *
 * No preview step. The design had one, but a preview of a CSV is a table the
 * dashboard already shows on the screen the report came from — it would be a
 * second, worse rendering of data the user just looked at. Each row states its
 * scope; the file is one click. It used to be a radio list with one button
 * under it: two clicks and a keyboard contract for the same thing.
 */
export function ReportBuilder({
  reports,
  rangeLabel,
  query,
}: {
  reports: ReportDef[]
  rangeLabel: string
  query: string
}) {
  const [downloading, setDownloading] = useState<string | null>(null)

  async function download(report: ReportDef) {
    setDownloading(report.key)
    try {
      // A plain navigation would work, but then a 403 or a 500 renders as a
      // blank tab. Fetching first means an error is a toast on the page they
      // are already looking at.
      const res = await fetch(`/api/reports/${report.key}?${query}`)
      if (!res.ok) {
        toast.error(await refusalText(res, "Could not build that report."))
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const filename =
        res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `${report.key}.csv`
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`${filename} downloaded`)
    } catch {
      toast.error("Could not reach the server.")
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <p className="text-[0.8125rem] text-muted-foreground">
        Reports cover the date range above — currently{" "}
        <b className="font-medium text-foreground">{rangeLabel}</b>. Every download is recorded in the audit log.
      </p>

      <ul className="overflow-hidden rounded-panel border border-border bg-card">
        {reports.map((report) => (
          <li key={report.key} className="[&:first-child>div]:border-t-0">
            <Row className="flex-wrap px-5 py-4">
              <IconFileSpreadsheet aria-hidden className="size-5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
                <span className="text-sm font-medium">{report.label}</span>
                <span className="text-[0.78125rem] leading-5 text-muted-foreground">{report.description}</span>
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void download(report)}
                disabled={downloading !== null}
                // Every row's button says "CSV"; the name says which.
                aria-label={`Download ${report.label} CSV`}
                className="pointer-coarse:h-11"
              >
                <IconDownload aria-hidden className="size-4" />
                {downloading === report.key ? "Building…" : "CSV"}
              </Button>
            </Row>
          </li>
        ))}
      </ul>

      <p className="text-[0.75rem] text-faint-foreground">
        UTF-8 with a byte-order mark, so accented names open correctly in Excel.
      </p>
    </div>
  )
}
