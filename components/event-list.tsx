"use client"

import { format } from "date-fns"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface Event {
  id: string
  title: string
  description: string
  start_time: Date
  end_time: Date
  venue_name?: string
  status: "draft" | "published" | "cancelled" | "completed"
  /** Counted from check-in rows, not a stored column. See lib/occupancy.ts. */
  occupancy: number
  max_capacity?: number
}

export function EventList({ events }: { events: Event[] }) {
  return (
    <div className="container mx-auto py-10">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Start Time</TableHead>
              <TableHead>End Time</TableHead>
              <TableHead>Venue</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Capacity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  No events found.
                </TableCell>
              </TableRow>
            ) : (
              events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="font-medium">{event.title}</TableCell>
                  <TableCell>{format(new Date(event.start_time), "PPp")}</TableCell>
                  <TableCell>{format(new Date(event.end_time), "PPp")}</TableCell>
                  <TableCell>{event.venue_name || "-"}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{event.status}</Badge>
                  </TableCell>
                  <TableCell>
                    {event.max_capacity
                      ? `${event.occupancy} / ${event.max_capacity}`
                      : event.occupancy}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
} 