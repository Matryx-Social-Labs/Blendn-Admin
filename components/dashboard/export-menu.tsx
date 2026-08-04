"use client"

import { logger } from "@/lib/logger"
import { useState } from "react"
import { IconDownload } from "@tabler/icons-react"
import { toast } from "sonner"

import type { DashboardExportBundle } from "@/lib/dashboard-types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

function escapeCsvValue(value: string | number | null) {
  if (value === null) {
    return ""
  }

  const stringValue = String(value)
  if (stringValue.includes(",") || stringValue.includes("\"") || stringValue.includes("\n")) {
    return `"${stringValue.replaceAll("\"", "\"\"")}"`
  }

  return stringValue
}

function bundleToCsv(bundle: DashboardExportBundle) {
  const lines = [
    bundle.columns.join(","),
    ...bundle.rows.map((row) => bundle.columns.map((column) => escapeCsvValue(row[column] ?? null)).join(",")),
  ]

  return lines.join("\n")
}

export function ExportMenu({ bundles }: { bundles: DashboardExportBundle[] }) {
  const [activeFile, setActiveFile] = useState<string | null>(null)

  const handleExport = (bundle: DashboardExportBundle) => {
    setActiveFile(bundle.filename)

    try {
      const blob = new Blob([bundleToCsv(bundle)], { type: "text/csv;charset=utf-8;" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = bundle.filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast.success(`${bundle.name} exported`)
    } catch (error) {
      logger.error("Export failed", { error: error instanceof Error ? error.message : String(error) })
      toast.error("Export failed")
    } finally {
      window.setTimeout(() => setActiveFile(null), 300)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="rounded-full">
          <IconDownload className="size-4" />
          {activeFile ? "Exporting..." : "Export data"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64 rounded-xl">
        <DropdownMenuLabel className="px-3 py-2 text-sm">
          Download reports
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {bundles.map((bundle) => (
          <DropdownMenuItem
            key={bundle.filename}
            onClick={() => handleExport(bundle)}
            className="rounded-lg px-3 py-2"
          >
            <div className="flex flex-col">
              <span className="font-medium">{bundle.name}</span>
              <span className="text-xs text-muted-foreground">{bundle.filename}</span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
