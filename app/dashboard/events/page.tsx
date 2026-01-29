"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { EventForm } from "@/components/event-form"
import { EventsTable } from "@/components/events-table"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { PlusIcon } from "@radix-ui/react-icons"
import { toast } from "sonner"

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

export default function EventsPage() {
  const router = useRouter()
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)

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

  const handleCreateEvent = async (data: Record<string, unknown>) => {
    try {
      const response = await fetch("/api/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        throw new Error("Failed to create event")
      }

      const newEvent = await response.json()
      setEvents((prev) => [...prev, newEvent])
      toast.success("Event created successfully")
      router.refresh()
    } catch (error) {
      console.error("Error creating event:", error)
      toast.error("Failed to create event")
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

  return (
    <div className="container mx-auto py-10">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Events</h1>
        <Sheet>
          <SheetTrigger asChild>
            <Button>
              <PlusIcon className="h-4 w-4 mr-2" />
              Create Event
            </Button>
          </SheetTrigger>
          <SheetContent className="w-[400px] sm:w-[540px]">
            <SheetHeader>
              <SheetTitle>Create New Event</SheetTitle>
            </SheetHeader>
            <div className="py-4">
              <EventForm onSubmit={handleCreateEvent} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
      <EventsTable events={events} />
    </div>
  )
}
