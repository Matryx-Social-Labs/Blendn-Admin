"use client"

import * as React from "react"
import { format } from "date-fns"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { IconDotsVertical } from "@tabler/icons-react"
import { updateEventStatus } from "@/lib/admin-role-actions"
import type { event_status } from "@prisma/client"

interface EventRow {
  id: string
  title: string
  status: event_status
  start_time: Date
  end_time: Date
  venue_name: string | null
  city: string | null
  attendeeCount: number
  max_capacity: number | null
}

// Words, on tokens. These were light-theme Tailwind greys and greens on a
// dark screen. Cancelled is the one that changed what happened.
const STATUS_STYLES: Record<event_status, string> = {
  draft: "text-muted-foreground",
  published: "text-foreground",
  cancelled: "font-bold text-destructive",
  completed: "text-muted-foreground",
}

interface UserEventsTableProps {
  events: EventRow[]
  isAdmin: boolean
}

export function UserEventsTable({ events, isAdmin }: UserEventsTableProps) {
  const [eventList, setEventList] = React.useState<EventRow[]>(events)
  const [loadingId, setLoadingId] = React.useState<string | null>(null)

  const handleStatusChange = async (eventId: string, status: event_status) => {
    setLoadingId(eventId)
    try {
      await updateEventStatus(eventId, status)
      setEventList((prev) =>
        prev.map((e) => (e.id === eventId ? { ...e, status } : e))
      )
      toast.success(`Event ${status}`)
    } catch {
      toast.error("Failed to update event status")
    } finally {
      setLoadingId(null)
    }
  }

  if (eventList.length === 0) {
    return (
      <div className="py-6 text-[0.8125rem] text-muted-foreground">
        No events yet.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto border-t border-border">
      <Table>
        <TableHeader className="bg-muted sticky top-0 z-10">
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Start</TableHead>
            <TableHead>Venue</TableHead>
            <TableHead>Attended</TableHead>
            {isAdmin && <TableHead className="w-16">Moderate</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {eventList.map((event) => (
            <TableRow key={event.id}>
              <TableCell className="font-medium max-w-[200px] truncate">{event.title}</TableCell>
              <TableCell>
                <span className={`text-[0.8125rem] ${STATUS_STYLES[event.status]}`}>{event.status}</span>
              </TableCell>
              <TableCell className="text-sm">
                {format(new Date(event.start_time), "MMM d, yyyy")}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {event.venue_name ?? event.city ?? "—"}
              </TableCell>
              <TableCell className="text-sm">
                {/* Real attendance, counted. `current_capacity` was a stored
                    counter no code has ever written. */}
                {event.max_capacity
                  ? `${event.attendeeCount} / ${event.max_capacity}`
                  : event.attendeeCount}
              </TableCell>
              {isAdmin && (
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        disabled={loadingId === event.id}
                        aria-label={`Actions for ${event.title}`}
                      >
                        <IconDotsVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {event.status !== "published" && (
                        <DropdownMenuItem
                          onClick={() => handleStatusChange(event.id, "published")}
                        >
                          Publish
                        </DropdownMenuItem>
                      )}
                      {event.status === "published" && (
                        <DropdownMenuItem
                          onClick={() => handleStatusChange(event.id, "draft")}
                        >
                          Unpublish
                        </DropdownMenuItem>
                      )}
                      {event.status !== "cancelled" && (
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => handleStatusChange(event.id, "cancelled")}
                        >
                          Cancel
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
