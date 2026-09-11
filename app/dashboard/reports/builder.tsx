"use client"

import { useState } from "react"
import { refusalText } from "@/lib/refusal"
import { IconDownload } from "@tabler/icons-react"
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

      {/* One list, one chosen row. Six cards with an orange icon each read as
          six primary things; the primary thing is the download button. */}
      <div
        role="radiogroup"
        aria-label="Report"
        className="flex flex-col divide-y divide-border"
        // A radiogroup promises arrow keys and one Tab stop; role alone
        // announces the contract without keeping it.
        onKeyDown={(e) => {
          const i = reports.findIndex((r) => r.key === selected?.key)
          const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0
          if (!step) return
          e.preventDefault()
          const next = reports[(i + step + reports.length) % reports.length]
          setSelected(next)
          ;(e.currentTarget.querySelector(`[data-key="${next.key}"]`) as HTMLElement | null)?.focus()
        }}
      >
        {reports.map((report) => {
          const on = selected?.key === report.key
          return (
            <button
              key={report.key}
              data-key={report.key}
              role="radio"
              aria-checked={on}
              tabIndex={on || (!selected && report === reports[0]) ? 0 : -1}
              onClick={() => setSelected(report)}
              className={cn(
                "grid grid-cols-[16px_1fr] items-baseline gap-x-3 py-3 text-left transition-colors hover:bg-accent/40 -mx-2 px-2 rounded-md",
                on ? "text-foreground" : "text-muted-foreground"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-1 size-3 self-start rounded-full border",
                  on ? "border-foreground bg-foreground" : "border-border-strong"
                )}
              />
              <span className="flex flex-col gap-0.5">
                <span className={cn("text-sm", on && "font-bold")}>{report.label}</span>
                <span className="text-[0.78125rem] leading-5 text-muted-foreground">
                  {report.description}
                </span>
              </span>
            </button>
          )
        })}
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
