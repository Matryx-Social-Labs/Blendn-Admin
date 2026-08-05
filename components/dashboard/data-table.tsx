import Link from "next/link"
import type { ReactNode } from "react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

export interface Column<T> {
  key: string
  label: string
  align?: "left" | "right"
  render?: (row: T) => ReactNode
  /** Hidden below the container's md breakpoint — mobile keeps the essentials. */
  secondary?: boolean
}

/**
 * The one table in the dashboard. Built for 5,000 rows rather than today's ten:
 * the toolbar and footer are slots so search, filters and pagination have a
 * home from the start instead of being bolted on when volume arrives.
 *
 * `emptyState` is required, not optional. Most of this product is empty at ~44
 * users, so a table with no rows is the common case, not the edge one.
 */
export function DataTable<T extends { id: string | number }>({
  columns,
  rows,
  emptyState,
  toolbar,
  footer,
  rowHref,
  className,
}: {
  columns: Column<T>[]
  rows: T[]
  emptyState: ReactNode
  toolbar?: ReactNode
  footer?: ReactNode
  rowHref?: (row: T) => string
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {toolbar}
      {rows.length === 0 ? (
        emptyState
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {columns.map((column) => (
                  <TableHead
                    key={column.key}
                    className={cn(
                      "h-10 px-3 text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground",
                      column.align === "right" && "text-right",
                      column.secondary && "hidden @2xl/main:table-cell"
                    )}
                  >
                    {column.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className="border-border">
                  {columns.map((column) => {
                    const content = column.render
                      ? column.render(row)
                      : String((row as Record<string, unknown>)[column.key] ?? "—")
                    return (
                      <TableCell
                        key={column.key}
                        className={cn(
                          "px-3 py-2.5 text-[0.8125rem]",
                          column.align === "right" && "text-right tabular-nums",
                          column.secondary && "hidden @2xl/main:table-cell"
                        )}
                      >
                        {rowHref && column.key === columns[0].key ? (
                          <Link
                            href={rowHref(row)}
                            className="font-medium hover:text-primary hover:underline"
                          >
                            {content}
                          </Link>
                        ) : (
                          content
                        )}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {footer ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[0.75rem] text-faint-foreground">
          {footer}
        </div>
      ) : null}
    </div>
  )
}
