"use client"

import { logger } from "@/lib/logger"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useSession } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { EventsTable } from "@/components/events-table"
import { PlusIcon } from "@radix-ui/react-icons"
import { toast } from "sonner"

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
  max_capacity?: number | null
  /** Counted from check-in rows. See lib/occupancy.ts. */
  occupancy: number
  external_link?: string | null
  organizer_id: string
}

export default function EventsPage() {
  const router = useRouter()
  const { data: session } = useSession()
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)

  const currentUserId = session?.user?.id
  const currentUserRole = session?.user?.role

  useEffect(() => {
    fetchEvents()
  }, [])

  const fetchEvents = async () => {
    try {
      const response = await fetch("/api/events")
      if (!response.ok) {
        throw new Error("Failed to fetch events")
      }
      const data = await response.json()
      setEvents(data)
    } catch (error) {
      logger.error("Error fetching events", { error: error instanceof Error ? error.message : String(error) })
      toast.error("Failed to load events")
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteEvent = async (event: Event) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete "${event.title}"? This cannot be undone.`
    )
    if (!confirmed) return

    try {
      const response = await fetch(`/api/events/${event.id}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        throw new Error("Failed to delete event")
      }

      setEvents((prev) => prev.filter((item) => item.id !== event.id))
      toast.success("Event deleted successfully")
      router.refresh()
    } catch (error) {
      logger.error("Error deleting event", { error: error instanceof Error ? error.message : String(error) })
      toast.error("Failed to delete event")
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-6 py-6">
        <div className="px-4 lg:px-6">
          <div className="rounded-xl border bg-card px-6 py-6">
            <h1 className="text-3xl font-semibold text-foreground">Events</h1>
          </div>
        </div>
        <div className="px-4 lg:px-6">
          <div className="flex h-64 items-center justify-center rounded-xl border bg-muted/50">
            <div className="text-muted-foreground">Loading events...</div>
          </div>
        </div>
      </div>
    )
  }

  const canCreate = currentUserRole === "app_admin" || currentUserRole === "organizer"

  return (
    <div className="flex flex-col gap-6 py-6">
      <div className="px-4 lg:px-6">
        <div className="flex flex-col gap-4 rounded-xl border bg-card px-6 py-6 @2xl/main:flex-row @2xl/main:items-end @2xl/main:justify-between">
          <div>
            <h1 className="text-3xl font-semibold text-foreground">Events</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              View event inventory, update publishing state, and keep operator workflows moving.
            </p>
          </div>
          {canCreate && (
            <Button
              onClick={() => router.push("/dashboard/events/new")}
              className="rounded-full"
            >
              <PlusIcon className="h-4 w-4" />
              Create Event
            </Button>
          )}
        </div>
      </div>
      <div className="px-4 lg:px-6">
        <div className="rounded-xl border bg-card p-5">
          <EventsTable
            events={events}
            onEdit={(event) => router.push(`/dashboard/events/${event.id}/edit`)}
            onDelete={handleDeleteEvent}
            currentUserId={currentUserId}
            currentUserRole={currentUserRole}
          />
        </div>
      </div>
    </div>
  )
}
