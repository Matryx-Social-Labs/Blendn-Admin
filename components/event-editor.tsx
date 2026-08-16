"use client"

import { logger } from "@/lib/logger"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import { format } from "date-fns"
import { toZonedTime, fromZonedTime } from "date-fns-tz"
import type { AmenityOption } from "@/components/event-form/amenities-section"
import { EventForm, type EventFormValues } from "@/components/event-form"
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
  venue_id?: string | null
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
  min_age?: number | null
  latitude?: number | null
  longitude?: number | null
  cover_image_url?: string | null
  external_link?: string | null
  is_featured?: boolean | null
  check_in_radius?: number | null
  geofence?: unknown
  category_ids?: string[]
  amenity_ids?: string[]
  primary_category_id?: string | null
  house_rules?: string | null
  cancellation_policy?: string | null
  additional_info?: unknown
  faq?: unknown
  accessibility_info?: unknown
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
  amenities?: AmenityOption[]
  initialEvent?: EventEditorData
}

const formatDateTimeInput = (value?: string, timezone = "Asia/Kolkata") => {
  if (!value) return ""
  // Convert the UTC timestamp from the DB into the event's timezone for display
  return format(toZonedTime(new Date(value), timezone), "yyyy-MM-dd'T'HH:mm")
}

const parseToKvArray = (value: unknown): Array<{ key: string; value: string }> => {
  if (!value) return []
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value
    if (Array.isArray(parsed)) {
      // Already an array — check shape
      return parsed.filter((item) => item && typeof item.key === "string")
    }
    if (typeof parsed === "object" && parsed !== null) {
      return Object.entries(parsed).map(([k, v]) => ({
        key: k,
        value: String(v),
      }))
    }
  } catch {}
  return []
}

const parseToFaqArray = (value: unknown): Array<{ question: string; answer: string }> => {
  if (!value) return []
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item) =>
          item &&
          (typeof item.question === "string" || typeof item.q === "string")
      ).map((item) => ({
        question: item.question ?? item.q ?? "",
        answer: item.answer ?? item.a ?? "",
      }))
    }
  } catch {}
  return []
}

export function EventEditor({ categories, amenities = [], initialEvent }: EventEditorProps) {
  const router = useRouter()
  const [isSaving, setIsSaving] = useState(false)
  const isEditing = Boolean(initialEvent?.id)

  const defaultValues = useMemo((): Partial<EventFormValues> | undefined => {
    if (!initialEvent) return undefined
    return {
      title: initialEvent.title,
      description: initialEvent.description,
      full_description: initialEvent.full_description,
      short_description: initialEvent.short_description ?? undefined,
      venue_name: initialEvent.venue_name ?? undefined,
      // Re-hydrates the picker; the location section loads the venue from it.
      venue_id: initialEvent.venue_id ?? null,
      address: initialEvent.address ?? undefined,
      city: initialEvent.city ?? undefined,
      state: initialEvent.state ?? undefined,
      country: initialEvent.country ?? undefined,
      postal_code: initialEvent.postal_code ?? undefined,
      start_time: formatDateTimeInput(initialEvent.start_time, initialEvent.timezone),
      end_time: formatDateTimeInput(initialEvent.end_time, initialEvent.timezone),
      timezone: initialEvent.timezone,
      status: initialEvent.status,
      visibility: initialEvent.visibility,
      max_capacity: initialEvent.max_capacity ?? undefined,
      min_age: initialEvent.min_age ?? undefined,
      latitude: initialEvent.latitude ?? undefined,
      longitude: initialEvent.longitude ?? undefined,
      cover_image_url: initialEvent.cover_image_url ?? undefined,
      external_link: initialEvent.external_link ?? undefined,
      is_featured: initialEvent.is_featured ?? false,
      check_in_radius: initialEvent.check_in_radius ?? 100,
      geofence: initialEvent.geofence ?? undefined,
      category_ids: initialEvent.category_ids ?? [],
      amenity_ids: initialEvent.amenity_ids ?? [],
      primary_category_id: initialEvent.primary_category_id ?? undefined,
      house_rules: initialEvent.house_rules ?? undefined,
      cancellation_policy: initialEvent.cancellation_policy ?? undefined,
      faq: parseToFaqArray(initialEvent.faq),
      additional_info: parseToKvArray(initialEvent.additional_info),
      accessibility_info: parseToKvArray(initialEvent.accessibility_info),
      media_items:
        initialEvent.media_items?.map((item) => ({
          id: crypto.randomUUID(),
          type: item.type,
          url: item.url,
          thumbnail_url: item.thumbnail_url ?? undefined,
          title: item.title ?? undefined,
          description: item.description ?? undefined,
        })) ?? [],
    }
  }, [initialEvent])

  const handleSubmit = async (data: EventFormValues) => {
    try {
      setIsSaving(true)

      // Convert datetimes from event timezone → UTC before sending to API
      const tz = data.timezone || "Asia/Kolkata"
      const toUtcIso = (localStr: string) =>
        localStr ? fromZonedTime(localStr, tz).toISOString() : localStr

      // Transform structured arrays back to JSON for the API
      const payload = {
        ...data,
        start_time: toUtcIso(data.start_time),
        end_time: toUtcIso(data.end_time),
        faq:
          data.faq && data.faq.length > 0 ? JSON.stringify(data.faq) : undefined,
        additional_info:
          data.additional_info && data.additional_info.length > 0
            ? JSON.stringify(
                Object.fromEntries(data.additional_info.map((kv) => [kv.key, kv.value]))
              )
            : undefined,
        accessibility_info:
          data.accessibility_info && data.accessibility_info.length > 0
            ? JSON.stringify(
                Object.fromEntries(
                  data.accessibility_info.map((kv) => [kv.key, kv.value])
                )
              )
            : undefined,
        // Strip internal id field from media items and re-add order
        media_items: data.media_items?.map((item, index) => ({
          type: item.type,
          url: item.url,
          thumbnail_url: item.thumbnail_url || undefined,
          title: item.title || undefined,
          description: item.description || undefined,
          order: index,
        })),
        // Explicit null, not undefined: `undefined` disappears in JSON and the
        // PATCH route reads an absent field as "leave it alone", so clearing
        // the box would silently keep the old restriction.
        min_age: data.min_age ?? null,
        // Cover image: treat empty string as undefined
        cover_image_url: data.cover_image_url || undefined,
        external_link: data.external_link || undefined,
        // Status: always "draft" on create (server default), only sent on edit
        status: isEditing ? data.status : "draft",
      }

      const response = await fetch(
        isEditing ? `/api/events/${initialEvent?.id}` : "/api/events",
        {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
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
      logger.error("Error saving event", { error: error instanceof Error ? error.message : String(error) })
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
            {isEditing ? "Edit Event" : "Create Event"}
          </h1>
          <p className="text-muted-foreground text-sm">
            {isEditing
              ? "Update event details, location, and settings."
              : "Fill in the details below — the event will be saved as a draft."}
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/dashboard/events">Back to Events</Link>
        </Button>
      </div>
      <EventForm
        onSubmit={handleSubmit}
        defaultValues={defaultValues}
        submitLabel={isEditing ? "Save Changes" : "Create Event"}
        isSubmitting={isSaving}
        isEditing={isEditing}
        categories={categories}
        amenities={amenities}
      />
    </div>
  )
}
