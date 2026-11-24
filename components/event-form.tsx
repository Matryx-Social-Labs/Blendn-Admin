"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useFieldArray, useForm, useWatch } from "react-hook-form"
import { format } from "date-fns"
import { Form } from "@/components/ui/form"
import { toast } from "sonner"
import type { LocationData } from "@/components/location-picker"
import { submitAsStatus } from "@/components/event-form/submit-as-status"
import { eventFormSchema, type EventFormValues } from "@/components/event-form/schema"
import {
  BasicInfoSection,
  type CategoryOption,
} from "@/components/event-form/basic-info-section"
import { LocationSection } from "@/components/event-form/location-section"
import { saveAsVenue } from "@/components/event-form/save-as-venue"
import { ScheduleSection } from "@/components/event-form/schedule-section"
import { AmenitiesSection, type AmenityOption } from "@/components/event-form/amenities-section"
import { CapacitySettingsSection } from "@/components/event-form/capacity-settings-section"
import { MediaSection } from "@/components/event-form/media-section"
import { PublishBar, PublishRail } from "@/components/event-form/publish-rail"
import { FormSection } from "@/components/event-form/form-section"
import { eventReadiness } from "@/lib/event-readiness"
import { AdvancedSection } from "@/components/event-form/advanced-section"
import { uploadFile } from "@/components/event-form/upload"
import { captureVideoPoster } from "@/lib/video-poster"
import { readMediaSize } from "@/lib/media-size"
import { uploadMediaItem } from "@/components/event-form/upload-media-item"
import { DEFAULT_CHECK_IN_RADIUS_M } from "@/lib/constants"
import { Refusal } from "@/lib/refusal"

export type { EventFormValues } from "@/components/event-form/schema"

// ── Main form ─────────────────────────────────────────────────────────────────

interface EventFormProps {
  /** Resolves true when the save landed; anything else puts the status back (`submitAsStatus`). */
  onSubmit: (data: EventFormValues) => Promise<boolean>
  defaultValues?: Partial<EventFormValues>
  isSubmitting?: boolean
  isEditing?: boolean
  /** app_admin only: the Featured switch, and the API's acceptance of it. */
  canFeature?: boolean
  categories?: CategoryOption[]
  /** The seeded amenity vocabulary. Empty is a valid state: no picker drawn. */
  amenities?: AmenityOption[]
}

/** The fields the readiness rule reads -- subscribed to as a set, not the form. */
const READINESS_FIELDS = [
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
] as const

export function EventForm({
  onSubmit,
  defaultValues,
  isSubmitting = false,
  isEditing = false,
  canFeature = false,
  categories = [],
  amenities = [],
}: EventFormProps) {
  const resolvedDefaultValues = useMemo(
    () => ({
      timezone: "Asia/Kolkata",
      status: "draft" as const,
      visibility: "public" as const,
      is_featured: false,
      crews_enabled: true,
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
      // Strings from the first render: undefined made these inputs switch from
      // uncontrolled to controlled, and an empty one refused with "Invalid
      // input: expected string, received undefined" instead of its own sentence.
      title: "",
      description: "",
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
  const [mediaUploadProgress, setMediaUploadProgress] = useState<Record<string, number>>({})

  // ── Upload helpers ──────────────────────────────────────────────────────────

  /** Keyed by the item's id, so the bar follows its item through a drag. */
  const handleMediaUpload = async (file: File, itemId: string): Promise<string | null> => {
    const setProgress = (percent: number) => setMediaUploadProgress((p) => ({ ...p, [itemId]: percent }))
    try {
      setProgress(0)
      const result = await uploadMediaItem(file, itemId, {
        items: () => form.getValues("media_items") ?? [],
        write: (index, patch) => {
          form.setValue(`media_items.${index}.url`, patch.url, { shouldValidate: true })
          form.setValue(`media_items.${index}.width`, patch.width)
          form.setValue(`media_items.${index}.height`, patch.height)
          form.setValue(`media_items.${index}.duration_ms`, patch.duration_ms)
          form.setValue(`media_items.${index}.focal_x`, patch.focal_x)
          form.setValue(`media_items.${index}.focal_y`, patch.focal_y)
          if (patch.thumbnail_url !== undefined) form.setValue(`media_items.${index}.thumbnail_url`, patch.thumbnail_url)
        },
        upload: uploadFile,
        readSize: readMediaSize,
        /*
         * A clip's poster is its own opening frame, taken from the file just
         * picked: every surface paints the poster and mounts the player over
         * it, so a different picture (the cover) visibly swaps when the clip
         * starts. Non-fatal: a codec the browser cannot decode still uploads.
         */
        capturePoster: captureVideoPoster,
        onProgress: setProgress,
      })
      if (result.kind === "refused") return result.reason
      if (result.kind === "done") {
        if (result.posterMissing) toast.info("Add a poster image for this clip so it does not flash when it loads.")
        toast.success("Media uploaded")
      }
    } catch (err) {
      toast.error(err instanceof Refusal ? err.message : "Failed to upload media")
    } finally {
      setMediaUploadProgress((p) => {
        const next = { ...p }
        delete next[itemId]
        return next
      })
    }
    return null
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
   * keystroke in any field. This subscribes to only the fields the rule reads (`READINESS_FIELDS`),
   * so typing a title does not redraw a map.
   */
  const watched = useWatch({ control: form.control, name: READINESS_FIELDS })
  // Keyed off the one list, so a field added to it cannot land in the wrong
  // slot. The first version repeated the ten names three times -- the
  // subscription, a positional destructure and the call -- and nothing but eye
  // kept them aligned.
  const readiness = useMemo(
    () =>
      eventReadiness(
        Object.fromEntries(READINESS_FIELDS.map((key, i) => [key, watched[i]])) as Partial<EventFormValues>
      ),
    [watched]
  )

  // ── The rail's inputs ───────────────────────────────────────────────────────

  const [cardTitle, cardLine, cardCover, cardCategoryId, cardStart, storedStatus] = useWatch({
    control: form.control,
    name: ["title", "short_description", "cover_image_url", "primary_category_id", "start_time", "status"],
  })
  const card = {
    title: cardTitle ?? "",
    line: cardLine ?? "",
    coverUrl: cardCover ?? "",
    category: categories.find((c) => c.id === cardCategoryId)?.name ?? "",
    when: cardStart ? safeFormat(cardStart) : "",
  }

  /*
   * The buttons decide the status; the form carries no Status select.
   * `status` stays a schema field, so the API payload is unchanged.
   */
  const submitAs = (status: EventFormValues["status"]) => {
    void submitAsStatus(form, status, submit)
  }
  const [listingVenue, setListingVenue] = useState(false)
  // The rail disables on the state above one render late; this refuses a
  // second click in between, which would list the place twice (React review).
  const submitting = useRef(false)
  /*
   * A place picked from the map is listed before the event saves, so the event
   * links to it (SCRUM-353c). Its id goes back into the form: a retry after a
   * refused event save links that venue rather than adding it twice.
   */
  const submit = async (data: EventFormValues): Promise<boolean> => {
    if (submitting.current) return false
    submitting.current = true
    setListingVenue(true)
    try {
      const venueId = await saveAsVenue(data)
      if (venueId) {
        form.setValue("venue_id", venueId)
        form.setValue("venue_link_status", "auto_linked")
        form.setValue("new_venue", null)
      }
      return await onSubmit(venueId ? { ...data, venue_id: venueId, venue_link_status: "auto_linked", new_venue: null } : data)
    } finally {
      submitting.current = false
      setListingVenue(false)
    }
  }
  const cancelEvent = () => {
    if (
      window.confirm(
        "Cancel this event? Everyone going is told, check-ins close, and the room archives. This cannot be undone."
      )
    ) {
      submitAs("cancelled")
    }
  }
  const railProps = {
    readiness,
    isEditing,
    isSubmitting: isSubmitting || listingVenue,
    status: (storedStatus ?? "draft") as EventFormValues["status"],
    onSaveDraft: () => submitAs("draft"),
    onPublish: () => submitAs("published"),
    onSaveChanges: () => submitAs(storedStatus ?? "published"),
    onCancelEvent: cancelEvent,
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Form {...form}>
      <form
        onSubmit={(e) => e.preventDefault()}
        className="grid gap-5 @4xl/main:grid-cols-[minmax(0,1fr)_300px]"
      >
        <div className="flex min-w-0 flex-col gap-5">
          <BasicInfoSection
            form={form}
            categories={categories}
            cover={{
              form,
              isUploadingCover,
              setIsUploadingCover,
              coverUploadProgress,
              setCoverUploadProgress,
            }}
          />

          <ScheduleSection form={form} />

          <LocationSection form={form} onLocationChange={handleLocationChange} />

          <CapacitySettingsSection form={form} canFeature={canFeature} />

          <FormSection
            step="05"
            title="More"
            hint="gallery · what's included · house rules · cancellation · FAQ · accessibility · long description"
            collapsible
            defaultOpen={false}
          >
            <MediaSection
              form={form}
              mediaFieldArray={mediaFieldArray}
              mediaUploadProgress={mediaUploadProgress}
              onUpload={handleMediaUpload}
            />
            <AmenitiesSection form={form} amenities={amenities} />
            <AdvancedSection
              form={form}
              faqFieldArray={faqFieldArray}
              additionalInfoFieldArray={additionalInfoFieldArray}
              accessibilityInfoFieldArray={accessibilityInfoFieldArray}
            />
          </FormSection>

          <PublishBar {...railProps} />
        </div>

        <PublishRail {...railProps} card={card} />
      </form>
    </Form>
  )
}

/** A `datetime-local` string as the card's date line; the raw string if it does not parse. */
function safeFormat(value: string) {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : format(d, "EEE d MMM · HH:mm")
}
