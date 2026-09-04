"use client"

import { useState } from "react"
import { refusalText } from "@/lib/refusal"
import { IconDownload, IconFileSpreadsheet } from "@tabler/icons-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ReportDef } from "@/lib/reports"

/**
 * Pick a report, confirm the window, download.
 *
 * No preview step. The design had one, but a preview of a CSV is a table the
 * dashboard already shows on the screen the report came from — it would be a
 * second, worse rendering of data the user just looked at. Selecting a report
 * states its row scope and what the columns are; the file is one click.
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
  const [selected, setSelected] = useState<ReportDef | null>(reports[0] ?? null)
  const [downloading, setDownloading] = useState(false)

  async function download() {
    if (!selected) return
    setDownloading(true)
    try {
      // A plain navigation would work, but then a 403 or a 500 renders as a
      // blank tab. Fetching first means an error is a toast on the page they
      // are already looking at.
      const res = await fetch(`/api/reports/${selected.key}?${query}`)
      if (!res.ok) {
        toast.error(await refusalText(res, "Could not build that report."))
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const filename =
        res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ??
        `${selected.key}.csv`
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`${filename} downloaded`)
    } catch {
      toast.error("Could not reach the server.")
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <p className="text-[0.8125rem] text-muted-foreground">
        Reports cover the date range in the top bar — currently{" "}
        <b className="font-medium text-foreground">{rangeLabel}</b>. Change it there and the export
        follows. Every download is recorded in the audit log.
      </p>

      <div className="grid gap-2 @2xl/main:grid-cols-2">
        {reports.map((report) => (
          <button
            key={report.key}
            onClick={() => setSelected(report)}
            aria-pressed={selected?.key === report.key}
            className={cn(
              "flex flex-col gap-1 rounded-lg border p-4 text-left transition-colors",
              selected?.key === report.key
                ? "border-primary bg-primary/5"
                : "border-border bg-card hover:border-muted-foreground/40"
            )}
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <IconFileSpreadsheet className="size-4 text-primary" />
              {report.label}
            </span>
            <span className="text-[0.78125rem] leading-5 text-muted-foreground">
              {report.description}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
        <Button onClick={download} disabled={!selected || downloading}>
          <IconDownload className="size-4" />
          {downloading ? "Building…" : `Download ${selected?.label ?? ""} CSV`}
        </Button>
        <span className="text-[0.75rem] text-faint-foreground">
          UTF-8 with a byte-order mark, so accented names open correctly in Excel.
        </span>
      </div>
    </div>
  )
}
