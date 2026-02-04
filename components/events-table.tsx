"use client"

import * as React from "react"
import {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { format } from "date-fns"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ArrowUpDown } from "lucide-react"

interface Event {
  id: string
  title: string
  description: string
  short_description?: string | null
  start_time: string | Date
  end_time: string | Date
  venue_name?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  postal_code?: string | null
  timezone: string
  status: "draft" | "published" | "cancelled" | "completed"
  current_capacity: number
  max_capacity?: number | null
  external_link?: string | null
}

const getColumns = (
  actions?: {
    onEdit?: (event: Event) => void
    onDelete?: (event: Event) => void
  }
): ColumnDef<Event>[] => [
  {
    accessorKey: "title",
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Title
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      )
    },
  },
  {
    accessorKey: "start_time",
    header: "Start Time",
    cell: ({ row }) => {
      return format(new Date(row.getValue("start_time")), "PPp")
    },
  },
  {
    accessorKey: "end_time",
    header: "End Time",
    cell: ({ row }) => {
      return format(new Date(row.getValue("end_time")), "PPp")
    },
  },
  {
    accessorKey: "venue_name",
    header: "Venue",
  },
  {
    accessorKey: "status",
    header: "Status",
  },
  {
    accessorKey: "current_capacity",
    header: "Capacity",
    cell: ({ row }) => {
      const maxCapacity = row.original.max_capacity
      return maxCapacity
        ? `${row.getValue("current_capacity")} / ${maxCapacity}`
        : row.getValue("current_capacity")
    },
  },
  {
    id: "actions",
    header: "Actions",
    cell: ({ row }) => {
      if (!actions?.onEdit && !actions?.onDelete) return null
      const event = row.original
      return (
        <div className="flex items-center gap-2">
          {actions.onEdit && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions.onEdit?.(event)}
            >
              Edit
            </Button>
          )}
          {actions.onDelete && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => actions.onDelete?.(event)}
            >
              Delete
            </Button>
          )}
        </div>
      )
    },
  },
]

interface EventsTableProps {
  events: Event[]
  onEdit?: (event: Event) => void
  onDelete?: (event: Event) => void
}

export function EventsTable({ events, onEdit, onDelete }: EventsTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = React.useState({})
  const columns = React.useMemo(
    () => getColumns({ onEdit, onDelete }),
    [onEdit, onDelete]
  )

  const table = useReactTable({
    data: events,
    columns,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
  })

  return (
    <div className="w-full">
      <div className="flex items-center py-4">
        <Input
          placeholder="Filter events..."
          value={(table.getColumn("title")?.getFilterValue() as string) ?? ""}
          onChange={(event) =>
            table.getColumn("title")?.setFilterValue(event.target.value)
          }
          className="max-w-sm"
        />
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No events found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end space-x-2 py-4">
        <div className="text-muted-foreground flex-1 text-sm">
          {table.getFilteredSelectedRowModel().rows.length} of{" "}
          {table.getFilteredRowModel().rows.length} row(s) selected.
        </div>
        <div className="space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
} 
