"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import { format } from "date-fns"
import { EventForm } from "@/components/event-form"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"

interface CategoryOption {
  id: string
  name: string
}

interface EventEditorData {
  id?: string
  title: string
  description: string
  full_description: string
  short_description?: string | null
  venue_name?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  postal_code?: string | null
  start_time: string
  end_time: string
  timezone: string
  status: "draft" | "published" | "cancelled" | "completed"
  visibility: "public" | "private" | "unlisted"
  max_capacity?: number | null
  current_capacity?: number | null
  latitude?: number | null
  longitude?: number | null
  cover_image_url?: string | null
  external_link?: string | null
  is_featured?: boolean | null
  is_recurring?: boolean | null
  check_in_radius?: number | null
  category_ids?: string[]
  primary_category_id?: string | null
  house_rules?: string | null
  cancellation_policy?: string | null
  additional_info?: unknown
  faq?: unknown
  accessibility_info?: unknown
  covid_guidelines?: string | null
  media_items?: Array<{
    type: "image" | "video" | "document"
    url: string
    thumbnail_url?: string | null
    title?: string | null
    description?: string | null
    order?: number | null
  }>
}

interface EventEditorProps {
  categories: CategoryOption[]
  initialEvent?: EventEditorData
}

const formatDateTimeInput = (value?: string) => {
  if (!value) return ""
  return format(new Date(value), "yyyy-MM-dd'T'HH:mm")
}

export function EventEditor({ categories, initialEvent }: EventEditorProps) {
  const router = useRouter()
  const [isSaving, setIsSaving] = useState(false)

  const defaultValues = useMemo(() => {
    if (!initialEvent) return undefined
    return {
      title: initialEvent.title,
      description: initialEvent.description,
      full_description: initialEvent.full_description,
      short_description: initialEvent.short_description ?? undefined,
      venue_name: initialEvent.venue_name ?? undefined,
      address: initialEvent.address ?? undefined,
      city: initialEvent.city ?? undefined,
      state: initialEvent.state ?? undefined,
      country: initialEvent.country ?? undefined,
      postal_code: initialEvent.postal_code ?? undefined,
      start_time: formatDateTimeInput(initialEvent.start_time),
      end_time: formatDateTimeInput(initialEvent.end_time),
      timezone: initialEvent.timezone,
      status: initialEvent.status,
      visibility: initialEvent.visibility,
      max_capacity: initialEvent.max_capacity ?? undefined,
      current_capacity: initialEvent.current_capacity ?? undefined,
      latitude: initialEvent.latitude ?? undefined,
      longitude: initialEvent.longitude ?? undefined,
      cover_image_url: initialEvent.cover_image_url ?? undefined,
      external_link: initialEvent.external_link ?? undefined,
      is_featured: initialEvent.is_featured ?? false,
      is_recurring: initialEvent.is_recurring ?? false,
      check_in_radius: initialEvent.check_in_radius ?? undefined,
      category_ids: initialEvent.category_ids ?? [],
      primary_category_id: initialEvent.primary_category_id ?? undefined,
      house_rules: initialEvent.house_rules ?? undefined,
      cancellation_policy: initialEvent.cancellation_policy ?? undefined,
      additional_info: initialEvent.additional_info
        ? JSON.stringify(initialEvent.additional_info, null, 2)
        : undefined,
      faq: initialEvent.faq ? JSON.stringify(initialEvent.faq, null, 2) : undefined,
      accessibility_info: initialEvent.accessibility_info
        ? JSON.stringify(initialEvent.accessibility_info, null, 2)
        : undefined,
      covid_guidelines: initialEvent.covid_guidelines ?? undefined,
      media_items:
        initialEvent.media_items?.map((item, index) => ({
          type: item.type,
          url: item.url,
          thumbnail_url: item.thumbnail_url ?? undefined,
          title: item.title ?? undefined,
          description: item.description ?? undefined,
          order: item.order ?? index,
        })) ?? [],
    }
  }, [initialEvent])

  const handleSubmit = async (data: Record<string, unknown>) => {
    try {
      setIsSaving(true)
      const isEditing = Boolean(initialEvent?.id)
      const response = await fetch(
        isEditing ? `/api/events/${initialEvent?.id}` : "/api/events",
        {
          method: isEditing ? "PATCH" : "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(data),
        }
      )

      if (!response.ok) {
        throw new Error("Failed to save event")
      }

      const saved = await response.json()
      toast.success(isEditing ? "Event updated" : "Event created")

      if (!isEditing && saved?.id) {
        router.replace(`/dashboard/events/${saved.id}`)
      } else {
        router.refresh()
      }
    } catch (error) {
      console.error("Error saving event:", error)
      toast.error("Failed to save event")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="container mx-auto flex max-w-5xl flex-col gap-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">
            {initialEvent ? "Edit Event" : "Create Event"}
          </h1>
          <p className="text-muted-foreground text-sm">
            Manage all event details, categories, and settings.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/dashboard/events">Back to Events</Link>
        </Button>
      </div>
      <EventForm
        onSubmit={handleSubmit}
        defaultValues={defaultValues}
        submitLabel={initialEvent ? "Save Changes" : "Create Event"}
        isSubmitting={isSaving}
        categories={categories}
      />
    </div>
  )
}
