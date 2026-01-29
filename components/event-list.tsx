"use client"

import { DataTable } from "@/components/data-table"
import { ColumnDef } from "@tanstack/react-table"
import { format } from "date-fns"
import { Button } from "@/components/ui/button"
import { ArrowUpDown } from "lucide-react"

interface Event {
  id: string
  title: string
  description: string
  start_time: Date
  end_time: Date
  venue_name?: string
  status: "draft" | "published" | "cancelled" | "completed"
  current_capacity: number
  max_capacity?: number
}

const columns: ColumnDef<Event>[] = [
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
]

export function EventList({ events }: { events: Event[] }) {
  return (
    <div className="container mx-auto py-10">
      <DataTable columns={columns} data={events} />
    </div>
  )
} 