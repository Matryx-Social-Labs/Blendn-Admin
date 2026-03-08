"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useFieldArray, useForm } from "react-hook-form"
import * as z from "zod"
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { toast } from "sonner"
import {
  IconChevronDown,
  IconChevronUp,
  IconGripVertical,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react"
import { LocationPicker, type LocationData } from "@/components/location-picker"

// ── Schema ────────────────────────────────────────────────────────────────────

const faqItemSchema = z.object({
  question: z.string().min(1, "Question required"),
  answer: z.string().min(1, "Answer required"),
})

const kvItemSchema = z.object({
  key: z.string().min(1, "Key required"),
  value: z.string().min(1, "Value required"),
})

const eventFormSchema = z.object({
  title: z.string().min(3, { message: "Title must be at least 3 characters." }),
  description: z.string().min(10, { message: "Description must be at least 10 characters." }),
  full_description: z.string().min(10, { message: "Full description must be at least 10 characters." }),
  short_description: z.string().optional(),
  venue_name: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postal_code: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  check_in_radius: z.number().min(10).max(5000).optional(),
  start_time: z.string().min(1, { message: "Start time is required." }),
  end_time: z.string().min(1, { message: "End time is required." }),
  timezone: z.string().min(1, { message: "Timezone is required." }),
  status: z.enum(["draft", "published", "cancelled", "completed"]),
  visibility: z.enum(["public", "private", "unlisted"]),
  max_capacity: z.number().optional(),
  cover_image_url: z.string().url().optional().or(z.literal("")),
  external_link: z.string().url().optional().or(z.literal("")),
  is_featured: z.boolean().optional(),
  house_rules: z.string().optional(),
  cancellation_policy: z.string().optional(),
  faq: z.array(faqItemSchema).optional(),
  additional_info: z.array(kvItemSchema).optional(),
  accessibility_info: z.array(kvItemSchema).optional(),
  category_ids: z.array(z.string()).optional(),
  primary_category_id: z.string().optional(),
  media_items: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(["image", "video", "document"]),
        url: z.string().url(),
        thumbnail_url: z.string().url().optional().or(z.literal("")),
        title: z.string().optional(),
        description: z.string().optional(),
      })
    )
    .optional(),
})

export type EventFormValues = z.infer<typeof eventFormSchema>

// ── Helpers ───────────────────────────────────────────────────────────────────

const ALL_TIMEZONES: string[] = (() => {
  try {
    return (Intl as any).supportedValuesOf("timeZone") as string[]
  } catch {
    return [
      "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
      "America/Anchorage", "Pacific/Honolulu", "Europe/London", "Europe/Paris",
      "Europe/Berlin", "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata", "Asia/Bangkok",
      "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
      "UTC",
    ]
  }
})()

// ── Section component ─────────────────────────────────────────────────────────

function FormSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left font-semibold hover:bg-muted/50"
        onClick={() => setOpen((v) => !v)}
      >
        {title}
        {open ? (
          <IconChevronUp className="size-4 text-muted-foreground" />
        ) : (
          <IconChevronDown className="size-4 text-muted-foreground" />
        )}
      </button>
      {open && <div className="space-y-5 px-4 pb-5">{children}</div>}
    </div>
  )
}

// ── Timezone combobox ─────────────────────────────────────────────────────────

function TimezoneSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    if (!q) return ALL_TIMEZONES.slice(0, 50)
    return ALL_TIMEZONES.filter((tz) => tz.toLowerCase().includes(q)).slice(0, 50)
  }, [query])

  const select = (tz: string) => {
    onChange(tz)
    setQuery(tz)
    setOpen(false)
  }

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search timezone…"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-md border bg-background shadow-md">
          {filtered.map((tz) => (
            <button
              key={tz}
              type="button"
              className={`w-full px-3 py-1.5 text-left text-sm hover:bg-muted ${tz === value ? "font-medium" : ""}`}
              onMouseDown={() => select(tz)}
            >
              {tz}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Sortable media item ───────────────────────────────────────────────────────

function SortableMediaItem({
  fieldItem,
  index,
  form,
  onRemove,
  isUploading,
  onUpload,
}: {
  fieldItem: { id: string }
  index: number
  form: any
  onRemove: () => void
  isUploading: boolean
  onUpload: (file: File, index: number) => Promise<void>
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: fieldItem.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const previewUrl = form.watch(`media_items.${index}.url`)
  const mediaType = form.watch(`media_items.${index}.type`)

  return (
    <div ref={setNodeRef} style={style} className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
            {...attributes}
            {...listeners}
          >
            <IconGripVertical className="size-5" />
          </button>
          <span className="text-sm font-medium">Media #{index + 1}</span>
        </div>
        <Button type="button" variant="destructive" size="sm" onClick={onRemove}>
          <IconTrash className="size-4" />
        </Button>
      </div>

      <FormField
        control={form.control}
        name={`media_items.${index}.type`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Type</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="image">Image</SelectItem>
                <SelectItem value="video">Video</SelectItem>
                <SelectItem value="document">Document</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`media_items.${index}.url`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>URL</FormLabel>
            <div className="flex flex-col gap-2">
              <FormControl>
                <Input placeholder="https://…" {...field} />
              </FormControl>
              <Input
                type="file"
                disabled={isUploading}
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (file) await onUpload(file, index)
                  e.target.value = ""
                }}
              />
              {previewUrl && mediaType === "image" && (
                <img
                  src={previewUrl}
                  alt={`Media ${index + 1}`}
                  className="max-h-40 w-full rounded-md border object-cover"
                />
              )}
            </div>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name={`media_items.${index}.title`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Title</FormLabel>
              <FormControl>
                <Input placeholder="Title" {...field} />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name={`media_items.${index}.description`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Caption</FormLabel>
              <FormControl>
                <Input placeholder="Caption" {...field} />
              </FormControl>
            </FormItem>
          )}
        />
      </div>
    </div>
  )
}

// ── Main form ─────────────────────────────────────────────────────────────────

interface EventFormProps {
  onSubmit: (data: EventFormValues) => void | Promise<void>
  defaultValues?: Partial<EventFormValues>
  submitLabel?: string
  isSubmitting?: boolean
  isEditing?: boolean
  categories?: Array<{ id: string; name: string }>
}

export function EventForm({
  onSubmit,
  defaultValues,
  submitLabel = "Create Event",
  isSubmitting = false,
  isEditing = false,
  categories = [],
}: EventFormProps) {
  const resolvedDefaultValues = useMemo(
    () => ({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      status: "draft" as const,
      visibility: "public" as const,
      is_featured: false,
      check_in_radius: 100,
      category_ids: [],
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
  const [mediaUploads, setMediaUploads] = useState<Record<number, boolean>>({})
  const coverPreviewUrl = form.watch("cover_image_url")
  const checkInRadius = form.watch("check_in_radius") ?? 100

  const sensors = useSensors(useSensor(PointerSensor))

  // ── Upload helpers ──────────────────────────────────────────────────────────

  const requestPresignedUrl = async (file: File) => {
    const res = await fetch("/api/uploads/presigned-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, contentType: file.type, folder: "events" }),
    })
    if (!res.ok) throw new Error("Failed to request upload URL")
    const payload = await res.json()
    if (!payload?.success || !payload?.data?.uploadUrl) throw new Error("No upload URL")
    return payload.data as { uploadUrl: string; publicUrl: string }
  }

  const uploadFile = async (file: File) => {
    const { uploadUrl, publicUrl } = await requestPresignedUrl(file)
    const up = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    })
    if (!up.ok) throw new Error("Upload failed")
    return publicUrl
  }

  const handleMediaUpload = async (file: File, index: number) => {
    try {
      setMediaUploads((p) => ({ ...p, [index]: true }))
      const url = await uploadFile(file)
      form.setValue(`media_items.${index}.url`, url, { shouldValidate: true })
      const type = form.getValues(`media_items.${index}.type`)
      if (type === "image" && !form.getValues(`media_items.${index}.thumbnail_url`)) {
        form.setValue(`media_items.${index}.thumbnail_url`, url)
      }
      toast.success("Media uploaded")
    } catch {
      toast.error("Failed to upload media")
    } finally {
      setMediaUploads((p) => ({ ...p, [index]: false }))
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

  const initialLat = form.getValues("latitude")
  const initialLng = form.getValues("longitude")

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">

        {/* ── Basic Info ── */}
        <FormSection title="Basic Info">
          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Title *</FormLabel>
                <FormControl>
                  <Input placeholder="Event title" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description *</FormLabel>
                <FormControl>
                  <Textarea placeholder="Short event description (shown on cards)" rows={3} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="full_description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Full Description *</FormLabel>
                <FormControl>
                  <Textarea placeholder="Detailed event information shown on the event page" rows={5} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="short_description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Short Description</FormLabel>
                <FormControl>
                  <Input placeholder="One-line summary (optional)" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Categories */}
          <FormField
            control={form.control}
            name="category_ids"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Categories</FormLabel>
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-2">
                    {categories.length === 0 && (
                      <p className="text-muted-foreground text-sm">No categories available.</p>
                    )}
                    {categories.map((cat) => {
                      const checked = field.value?.includes(cat.id) ?? false
                      return (
                        <label
                          key={cat.id}
                          className="flex items-center gap-2 rounded-md border p-2 text-sm cursor-pointer hover:bg-muted/50"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) => {
                              const next = field.value ? [...field.value] : []
                              if (v) {
                                next.push(cat.id)
                                if (!form.getValues("primary_category_id")) {
                                  form.setValue("primary_category_id", cat.id)
                                }
                              } else {
                                const updated = next.filter((id) => id !== cat.id)
                                if (form.getValues("primary_category_id") === cat.id) {
                                  form.setValue("primary_category_id", updated[0])
                                }
                                field.onChange(updated)
                                return
                              }
                              field.onChange(next)
                            }}
                          />
                          {cat.name}
                        </label>
                      )
                    })}
                  </div>

                  {field.value && field.value.length > 0 && (
                    <div className="space-y-1 rounded-md border p-3">
                      <p className="text-xs font-medium text-muted-foreground mb-2">
                        Select the primary category:
                      </p>
                      {field.value.map((catId) => {
                        const cat = categories.find((c) => c.id === catId)
                        if (!cat) return null
                        const primaryId = form.watch("primary_category_id")
                        return (
                          <label
                            key={catId}
                            className="flex items-center gap-2 text-sm cursor-pointer"
                          >
                            <input
                              type="radio"
                              name="primary_category_id"
                              className="h-4 w-4"
                              checked={primaryId === catId}
                              onChange={() => form.setValue("primary_category_id", catId)}
                            />
                            {cat.name}
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </FormSection>

        {/* ── Location ── */}
        <FormSection title="Location">
          <FormField
            control={form.control}
            name="venue_name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Venue Name</FormLabel>
                <FormControl>
                  <Input placeholder="Venue or venue name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div>
            <FormLabel>Map Location</FormLabel>
            <div className="mt-2">
              <LocationPicker
                initialLat={initialLat}
                initialLng={initialLng}
                checkInRadius={checkInRadius}
                onLocationChange={handleLocationChange}
              />
            </div>
          </div>

          {/* Auto-filled address fields (read-only display, editable as fallback) */}
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem className="col-span-2">
                  <FormLabel>Address</FormLabel>
                  <FormControl>
                    <Input placeholder="Auto-filled from map" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="city"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>City</FormLabel>
                  <FormControl>
                    <Input placeholder="City" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="state"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>State / Region</FormLabel>
                  <FormControl>
                    <Input placeholder="State" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="country"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Country</FormLabel>
                  <FormControl>
                    <Input placeholder="Country" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="postal_code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Postal Code</FormLabel>
                  <FormControl>
                    <Input placeholder="Postal code" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* Hidden lat/lng — set by map */}
          <div className="grid grid-cols-2 gap-4 text-sm text-muted-foreground">
            <div>
              <span className="font-medium">Lat: </span>
              {form.watch("latitude")?.toFixed(6) ?? "—"}
            </div>
            <div>
              <span className="font-medium">Lng: </span>
              {form.watch("longitude")?.toFixed(6) ?? "—"}
            </div>
          </div>

          <FormField
            control={form.control}
            name="check_in_radius"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Check-in Radius —{" "}
                  <span className="font-normal text-muted-foreground">
                    {field.value ?? 100} m
                  </span>
                </FormLabel>
                <FormControl>
                  <input
                    type="range"
                    min={10}
                    max={5000}
                    step={10}
                    className="w-full accent-primary"
                    value={field.value ?? 100}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>10 m</span>
                  <span>5 000 m</span>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </FormSection>

        {/* ── Date & Time ── */}
        <FormSection title="Date & Time">
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="start_time"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Start *</FormLabel>
                  <FormControl>
                    <Input type="datetime-local" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="end_time"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>End *</FormLabel>
                  <FormControl>
                    <Input type="datetime-local" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="timezone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Timezone *</FormLabel>
                <FormControl>
                  <TimezoneSelect value={field.value} onChange={field.onChange} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </FormSection>

        {/* ── Capacity & Settings ── */}
        <FormSection title="Capacity & Settings">
          {isEditing && (
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="published">Published</SelectItem>
                      <SelectItem value="cancelled">Cancelled</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="visibility"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Visibility</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select visibility" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="public">Public</SelectItem>
                      <SelectItem value="private">Private</SelectItem>
                      <SelectItem value="unlisted">Unlisted</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="max_capacity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max Capacity</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="Unlimited if blank"
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value === "" ? undefined : Number(e.target.value)
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="is_featured"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel>Featured</FormLabel>
                    <div className="text-muted-foreground text-sm">
                      Highlight this event on the home screen.
                    </div>
                  </div>
                  <FormControl>
                    <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="external_link"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>External Link</FormLabel>
                  <FormControl>
                    <Input placeholder="https://…" {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </FormSection>

        {/* ── Cover Image ── */}
        <FormSection title="Cover Image" defaultOpen={true}>
          <p className="text-sm text-muted-foreground">
            Shown on event cards. Recommended 1200×630 px.
          </p>
          <FormField
            control={form.control}
            name="cover_image_url"
            render={({ field }) => (
              <FormItem>
                <div className="flex flex-col gap-3">
                  {coverPreviewUrl ? (
                    <div className="relative">
                      <img
                        src={coverPreviewUrl}
                        alt="Cover preview"
                        className="h-48 w-full rounded-lg border object-cover"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="absolute right-2 top-2"
                        onClick={() => form.setValue("cover_image_url", "")}
                      >
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <div className="flex h-48 w-full items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/25 bg-muted/50">
                      <span className="text-muted-foreground text-sm">No cover image</span>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <Input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={isUploadingCover}
                      className="cursor-pointer"
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        try {
                          setIsUploadingCover(true)
                          const url = await uploadFile(file)
                          form.setValue("cover_image_url", url, { shouldValidate: true })
                          toast.success("Cover image uploaded")
                        } catch {
                          toast.error("Failed to upload cover image")
                        } finally {
                          setIsUploadingCover(false)
                          e.target.value = ""
                        }
                      }}
                    />
                    {isUploadingCover && (
                      <span className="text-sm text-muted-foreground">Uploading…</span>
                    )}
                  </div>

                  <div className="flex flex-col gap-1">
                    <FormLabel className="text-xs text-muted-foreground">Or enter URL</FormLabel>
                    <FormControl>
                      <Input placeholder="https://…" {...field} value={field.value || ""} />
                    </FormControl>
                  </div>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </FormSection>

        {/* ── Gallery ── */}
        <FormSection title="Gallery" defaultOpen={false}>
          <p className="text-sm text-muted-foreground">
            Additional images shown on the event detail page. Drag to reorder.
          </p>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(event) => {
              const { active, over } = event
              if (over && active.id !== over.id) {
                const oldIndex = mediaFieldArray.fields.findIndex((f) => f.id === active.id)
                const newIndex = mediaFieldArray.fields.findIndex((f) => f.id === over.id)
                mediaFieldArray.move(oldIndex, newIndex)
              }
            }}
          >
            <SortableContext
              items={mediaFieldArray.fields.map((f) => f.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-3">
                {mediaFieldArray.fields.length === 0 && (
                  <p className="text-center text-sm text-muted-foreground py-4">
                    No gallery images yet.
                  </p>
                )}
                {mediaFieldArray.fields.map((fieldItem, index) => (
                  <SortableMediaItem
                    key={fieldItem.id}
                    fieldItem={fieldItem}
                    index={index}
                    form={form}
                    onRemove={() => mediaFieldArray.remove(index)}
                    isUploading={mediaUploads[index] ?? false}
                    onUpload={handleMediaUpload}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              mediaFieldArray.append({
                id: crypto.randomUUID(),
                type: "image",
                url: "",
                thumbnail_url: "",
                title: "",
                description: "",
              })
            }
          >
            <IconPlus className="size-4 mr-1" />
            Add Image
          </Button>
        </FormSection>

        {/* ── Advanced ── */}
        <FormSection title="Advanced" defaultOpen={false}>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="house_rules"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>House Rules</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Rules for attendees" rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="cancellation_policy"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Cancellation Policy</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Cancellation policy" rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* FAQ */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <FormLabel>FAQ</FormLabel>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => faqFieldArray.append({ question: "", answer: "" })}
              >
                <IconPlus className="size-4 mr-1" />
                Add Q&A
              </Button>
            </div>
            {faqFieldArray.fields.map((item, index) => (
              <div key={item.id} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Q&A #{index + 1}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => faqFieldArray.remove(index)}
                  >
                    <IconTrash className="size-4" />
                  </Button>
                </div>
                <FormField
                  control={form.control}
                  name={`faq.${index}.question`}
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Input placeholder="Question" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name={`faq.${index}.answer`}
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Textarea placeholder="Answer" rows={2} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            ))}
          </div>

          {/* Accessibility Info */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <FormLabel>Accessibility Info</FormLabel>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  accessibilityInfoFieldArray.append({ key: "", value: "" })
                }
              >
                <IconPlus className="size-4 mr-1" />
                Add
              </Button>
            </div>
            {accessibilityInfoFieldArray.fields.map((item, index) => (
              <div key={item.id} className="flex items-center gap-2">
                <FormField
                  control={form.control}
                  name={`accessibility_info.${index}.key`}
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormControl>
                        <Input placeholder="e.g. Wheelchair access" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name={`accessibility_info.${index}.value`}
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormControl>
                        <Input placeholder="Yes / details" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => accessibilityInfoFieldArray.remove(index)}
                >
                  <IconTrash className="size-4" />
                </Button>
              </div>
            ))}
          </div>

          {/* Additional Info */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <FormLabel>Additional Info</FormLabel>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  additionalInfoFieldArray.append({ key: "", value: "" })
                }
              >
                <IconPlus className="size-4 mr-1" />
                Add
              </Button>
            </div>
            {additionalInfoFieldArray.fields.map((item, index) => (
              <div key={item.id} className="flex items-center gap-2">
                <FormField
                  control={form.control}
                  name={`additional_info.${index}.key`}
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormControl>
                        <Input placeholder="Key" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name={`additional_info.${index}.value`}
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormControl>
                        <Input placeholder="Value" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => additionalInfoFieldArray.remove(index)}
                >
                  <IconTrash className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </FormSection>

        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? "Saving…" : submitLabel}
        </Button>
      </form>
    </Form>
  )
}
