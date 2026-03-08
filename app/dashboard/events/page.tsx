"use client"

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
  current_capacity: number
  max_capacity?: number | null
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
      console.error("Error fetching events:", error)
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
      console.error("Error deleting event:", error)
      toast.error("Failed to delete event")
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto py-10">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Events</h1>
        </div>
        <div className="flex items-center justify-center h-64">
          <div className="text-muted-foreground">Loading events...</div>
        </div>
      </div>
    )
  }

  const canCreate = currentUserRole === "app_admin" || currentUserRole === "organizer"

  return (
    <div className="container mx-auto py-10">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Events</h1>
        {canCreate && (
          <Button onClick={() => router.push("/dashboard/events/new")}>
            <PlusIcon className="h-4 w-4 mr-2" />
            Create Event
          </Button>
        )}
      </div>
      <EventsTable
        events={events}
        onEdit={(event) => router.push(`/dashboard/events/${event.id}`)}
        onDelete={handleDeleteEvent}
        currentUserId={currentUserId}
        currentUserRole={currentUserRole}
      />
    </div>
  )
}
