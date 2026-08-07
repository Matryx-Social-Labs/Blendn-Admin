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
import { IconSearch } from "@tabler/icons-react"
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
  /** Counted from check-in rows, not a stored column. See lib/occupancy.ts. */
  occupancy: number
  max_capacity?: number | null
  external_link?: string | null
  organizer_id: string
}

const getColumns = (
  actions?: {
    onEdit?: (event: Event) => void
    onDelete?: (event: Event) => void
  },
  currentUserId?: string,
  currentUserRole?: string
): ColumnDef<Event>[] => [
  {
    accessorKey: "title",
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          className="rounded-full px-0 hover:bg-transparent"
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
    accessorKey: "occupancy",
    header: "Capacity",
    cell: ({ row }) => {
      const maxCapacity = row.original.max_capacity
      return maxCapacity
        ? `${row.getValue("occupancy")} / ${maxCapacity}`
        : row.getValue("occupancy")
    },
  },
  {
    id: "actions",
    header: "Actions",
    cell: ({ row }) => {
      if (!actions?.onEdit && !actions?.onDelete) return null
      const event = row.original
      const canEdit =
        currentUserRole === "app_admin" ||
        (currentUserRole === "organizer" && event.organizer_id === currentUserId)

      if (!canEdit) return null

      return (
        <div className="flex items-center gap-2">
          {actions.onEdit && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions.onEdit?.(event)}
              className="rounded-full"
            >
              Edit
            </Button>
          )}
          {actions.onDelete && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => actions.onDelete?.(event)}
              className="rounded-full"
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
  currentUserId?: string
  currentUserRole?: string
}

export function EventsTable({ events, onEdit, onDelete, currentUserId, currentUserRole }: EventsTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = React.useState({})
  const columns = React.useMemo(
    () => getColumns({ onEdit, onDelete }, currentUserId, currentUserRole),
    [onEdit, onDelete, currentUserId, currentUserRole]
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
    <div className="w-full space-y-4">
      <div className="relative flex items-center">
        <IconSearch className="pointer-events-none absolute left-4 size-4 text-muted-foreground" />
        <Input
          placeholder="Filter events..."
          value={(table.getColumn("title")?.getFilterValue() as string) ?? ""}
          onChange={(event) =>
            table.getColumn("title")?.setFilterValue(event.target.value)
          }
          className="h-11 max-w-sm rounded-xl pl-11"
        />
      </div>
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead key={header.id} className="h-11 px-3 text-muted-foreground">
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
                    <TableCell key={cell.id} className="px-3 py-4">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  No events found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between gap-2 py-2">
        <div className="text-sm text-muted-foreground">
          Page {table.getState().pagination.pageIndex + 1} of{" "}
          {Math.max(table.getPageCount(), 1)}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="rounded-full"
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="rounded-full"
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}
