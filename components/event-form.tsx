"use client"

import { useEffect, useMemo, useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useFieldArray, useForm, useWatch } from "react-hook-form"
import { Button } from "@/components/ui/button"
import { Form } from "@/components/ui/form"
import { toast } from "sonner"
import type { LocationData } from "@/components/location-picker"
import { eventFormSchema, type EventFormValues } from "@/components/event-form/schema"
import {
  BasicInfoSection,
  type CategoryOption,
} from "@/components/event-form/basic-info-section"
import { LocationSection } from "@/components/event-form/location-section"
import { ScheduleSection } from "@/components/event-form/schedule-section"
import { AmenitiesSection, type AmenityOption } from "@/components/event-form/amenities-section"
import { CapacitySettingsSection } from "@/components/event-form/capacity-settings-section"
import { CoverImageSection } from "@/components/event-form/cover-image-section"
import { MediaSection } from "@/components/event-form/media-section"
import { ReadinessStrip } from "@/components/event-form/readiness-strip"
import { eventReadiness } from "@/lib/event-readiness"
import { AdvancedSection } from "@/components/event-form/advanced-section"
import { uploadFile } from "@/components/event-form/upload"
import { captureVideoPoster } from "@/lib/video-poster"
import { DEFAULT_CHECK_IN_RADIUS_M } from "@/lib/constants"

export type { EventFormValues } from "@/components/event-form/schema"

// ── Main form ─────────────────────────────────────────────────────────────────

interface EventFormProps {
  onSubmit: (data: EventFormValues) => void | Promise<void>
  defaultValues?: Partial<EventFormValues>
  submitLabel?: string
  isSubmitting?: boolean
  isEditing?: boolean
  categories?: CategoryOption[]
  /** The seeded amenity vocabulary. Empty is a valid state: no picker drawn. */
  amenities?: AmenityOption[]
}

export function EventForm({
  onSubmit,
  defaultValues,
  submitLabel = "Create Event",
  isSubmitting = false,
  isEditing = false,
  categories = [],
  amenities = [],
}: EventFormProps) {
  const resolvedDefaultValues = useMemo(
    () => ({
      timezone: "Asia/Kolkata",
      status: "draft" as const,
      visibility: "public" as const,
      is_featured: false,
      check_in_radius: DEFAULT_CHECK_IN_RADIUS_M,
      category_ids: [],
      amenity_ids: [],
      primary_category_id: undefined,
      media_items: [],
      faq: [],
      additional_info: [],
      accessibility_info: [],
      start_time: "",
      end_time: "",
      full_description: "",
      ...defaultValues,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventFormSchema),
    defaultValues: resolvedDefaultValues,
  })

  useEffect(() => {
    if (defaultValues) form.reset({ ...resolvedDefaultValues, ...defaultValues })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const mediaFieldArray = useFieldArray({ control: form.control, name: "media_items" })
  const faqFieldArray = useFieldArray({ control: form.control, name: "faq" })
  const additionalInfoFieldArray = useFieldArray({ control: form.control, name: "additional_info" })
  const accessibilityInfoFieldArray = useFieldArray({ control: form.control, name: "accessibility_info" })

  const [isUploadingCover, setIsUploadingCover] = useState(false)
  const [coverUploadProgress, setCoverUploadProgress] = useState(0)
  const [mediaUploadProgress, setMediaUploadProgress] = useState<Record<number, number>>({})

  // ── Upload helpers ──────────────────────────────────────────────────────────

  const handleMediaUpload = async (file: File, index: number) => {
    try {
      setMediaUploadProgress((p) => ({ ...p, [index]: 0 }))
      const url = await uploadFile(file, (percent) =>
        setMediaUploadProgress((p) => ({ ...p, [index]: percent }))
      )
      form.setValue(`media_items.${index}.url`, url, { shouldValidate: true })
      const type = form.getValues(`media_items.${index}.type`)
      if (type === "image" && !form.getValues(`media_items.${index}.thumbnail_url`)) {
        form.setValue(`media_items.${index}.thumbnail_url`, url)
      }

      /*
       * A video's poster is its own opening frame, taken here.
       *
       * Every surface paints the poster and mounts the player over it. When the
       * poster is a *different* picture — the event cover, which is the
       * fallback — the instant the clip produces its first frame the image
       * changes, and it reads as the screen settling and then re-settling.
       * Making the poster the first frame means nothing about the picture
       * changes at all, only which layer draws it.
       *
       * Done from the file the organiser has just picked, so it costs no
       * network: the alternative is a server round trip, a worker and a queue
       * for a frame the browser already has.
       *
       * Deliberately non-fatal. A codec the browser cannot decode, or a poster
       * they have already chosen, must not fail an upload that otherwise
       * worked — the manual field is still there and the cover still backs it.
       */
      if (type === "video" && !form.getValues(`media_items.${index}.thumbnail_url`)) {
        try {
          const poster = await captureVideoPoster(file)
          const posterUrl = await uploadFile(
            new File([poster], `${file.name.replace(/\.[^.]+$/, "")}-poster.jpg`, {
              type: "image/jpeg",
            })
          )
          form.setValue(`media_items.${index}.thumbnail_url`, posterUrl)
        } catch {
          toast.info("Add a poster image for this clip so it does not flash when it loads.")
        }
      }

      toast.success("Media uploaded")
    } catch {
      toast.error("Failed to upload media")
    } finally {
      setMediaUploadProgress((p) => {
        const next = { ...p }
        delete next[index]
        return next
      })
    }
  }

  // ── Location handler ────────────────────────────────────────────────────────

  const handleLocationChange = (data: LocationData) => {
    form.setValue("latitude", data.lat, { shouldValidate: true })
    form.setValue("longitude", data.lng, { shouldValidate: true })
    form.setValue("address", data.address)
    form.setValue("city", data.city)
    form.setValue("state", data.state)
    form.setValue("country", data.country)
    form.setValue("postal_code", data.postal_code)
  }

  /*
   * Recomputed as they type.
   *
   * `useWatch` rather than `form.watch()` in the body: the latter re-renders
   * this whole component — eight sections and two Leaflet maps — on every
   * keystroke in any field. This subscribes to the eight fields the rule reads,
   * so typing a title does not redraw a map.
   */
  const watched = useWatch({
    control: form.control,
    name: [
      "title",
      "start_time",
      "end_time",
      "timezone",
      "latitude",
      "longitude",
      "geofence",
      "check_in_radius",
      "category_ids",
      "cover_image_url",
    ],
  })
  const readiness = useMemo(() => {
    const [
      title,
      start_time,
      end_time,
      timezone,
      latitude,
      longitude,
      geofence,
      check_in_radius,
      category_ids,
      cover_image_url,
    ] = watched
    return eventReadiness({
      title,
      start_time,
      end_time,
      timezone,
      latitude,
      longitude,
      geofence,
      check_in_radius,
      category_ids,
      cover_image_url,
    })
  }, [watched])

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {/*
          First, because it answers the first question: can this be published?

          `canPublish()` refuses an event with no coordinates and no fence, and
          the organiser used to meet that refusal as a toast after filling in
          5,683px of form — having already scrolled past the map that fixes it.
          The form knew all along.
        */}
        <ReadinessStrip readiness={readiness} />

        <BasicInfoSection form={form} categories={categories} />

        <LocationSection form={form} onLocationChange={handleLocationChange} />

        <ScheduleSection form={form} />

        <CapacitySettingsSection form={form} isEditing={isEditing} />

        <AmenitiesSection form={form} amenities={amenities} />

        <CoverImageSection
          form={form}
          isUploadingCover={isUploadingCover}
          setIsUploadingCover={setIsUploadingCover}
          coverUploadProgress={coverUploadProgress}
          setCoverUploadProgress={setCoverUploadProgress}
        />

        <MediaSection
          form={form}
          mediaFieldArray={mediaFieldArray}
          mediaUploadProgress={mediaUploadProgress}
          onUpload={handleMediaUpload}
        />

        <AdvancedSection
          form={form}
          faqFieldArray={faqFieldArray}
          additionalInfoFieldArray={additionalInfoFieldArray}
          accessibilityInfoFieldArray={accessibilityInfoFieldArray}
        />

        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? "Saving…" : submitLabel}
        </Button>
      </form>
    </Form>
  )
}
