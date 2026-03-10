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
      <div className="flex flex-col gap-6 py-6">
        <div className="px-4 lg:px-6">
          <div className="rounded-[1.8rem] border border-white/10 brand-surface px-6 py-6">
            <h1 className="text-3xl font-semibold text-white">Events</h1>
            <p className="mt-2 text-sm leading-6 text-white/62">
              Manage event inventory, publishing status, and operational detail.
            </p>
          </div>
        </div>
        <div className="px-4 lg:px-6">
          <div className="flex h-64 items-center justify-center rounded-[1.8rem] border border-white/10 bg-white/[0.04]">
            <div className="text-white/56">Loading events...</div>
          </div>
        </div>
      </div>
    )
  }

  const canCreate = currentUserRole === "app_admin" || currentUserRole === "organizer"

  return (
    <div className="flex flex-col gap-6 py-6">
      <div className="px-4 lg:px-6">
        <div className="flex flex-col gap-4 rounded-[1.8rem] border border-white/10 brand-surface px-6 py-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold text-white">Events</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-white/62">
              View event inventory, update publishing state, and keep operator workflows moving.
            </p>
          </div>
          {canCreate && (
            <Button
              onClick={() => router.push("/dashboard/events/new")}
              className="rounded-full bg-[#F05423] text-white hover:bg-[#d84a1d]"
            >
              <PlusIcon className="h-4 w-4" />
              Create Event
            </Button>
          )}
        </div>
      </div>
      <div className="px-4 lg:px-6">
        <div className="rounded-[1.8rem] border border-white/10 bg-white/[0.04] p-5">
          <EventsTable
            events={events}
            onEdit={(event) => router.push(`/dashboard/events/${event.id}`)}
            onDelete={handleDeleteEvent}
            currentUserId={currentUserId}
            currentUserRole={currentUserRole}
          />
        </div>
      </div>
    </div>
  )
}
