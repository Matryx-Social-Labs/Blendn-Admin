"use client"

import { useEffect, useMemo, useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useFieldArray, useForm } from "react-hook-form"
import * as z from "zod"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { toast } from "sonner"

const jsonStringSchema = z
  .string()
  .optional()
  .refine(
    (value) => {
      if (!value || value.trim() === "") return true
      try {
        JSON.parse(value)
        return true
      } catch {
        return false
      }
    },
    { message: "Invalid JSON" }
  )

const eventFormSchema = z.object({
  title: z.string().min(3, {
    message: "Title must be at least 3 characters.",
  }),
  description: z.string().min(10, {
    message: "Description must be at least 10 characters.",
  }),
  full_description: z.string().min(10, {
    message: "Full description must be at least 10 characters.",
  }),
  short_description: z.string().optional(),
  venue_name: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postal_code: z.string().optional(),
  start_time: z.string().min(1, { message: "Start time is required." }),
  end_time: z.string().min(1, { message: "End time is required." }),
  timezone: z.string(),
  status: z.enum(["draft", "published", "cancelled", "completed"]),
  visibility: z.enum(["public", "private", "unlisted"]),
  max_capacity: z.number().optional(),
  current_capacity: z.number().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  cover_image_url: z.string().url().optional(),
  external_link: z.string().url().optional(),
  is_featured: z.boolean().optional(),
  is_recurring: z.boolean().optional(),
  check_in_radius: z.number().optional(),
  house_rules: z.string().optional(),
  cancellation_policy: z.string().optional(),
  additional_info: jsonStringSchema,
  faq: jsonStringSchema,
  accessibility_info: jsonStringSchema,
  covid_guidelines: z.string().optional(),
  category_ids: z.array(z.string()).optional(),
  primary_category_id: z.string().optional(),
  media_items: z
    .array(
      z.object({
        type: z.enum(["image", "video", "document"]),
        url: z.string().url(),
        thumbnail_url: z.string().url().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        order: z.number().optional(),
      })
    )
    .optional(),
})

type EventFormValues = z.infer<typeof eventFormSchema>

interface EventFormProps {
  onSubmit: (data: EventFormValues) => void | Promise<void>
  defaultValues?: Partial<EventFormValues>
  submitLabel?: string
  isSubmitting?: boolean
  categories?: Array<{ id: string; name: string }>
}

export function EventForm({
  onSubmit,
  defaultValues,
  submitLabel = "Create Event",
  isSubmitting = false,
  categories = [],
}: EventFormProps) {
  const resolvedDefaultValues = useMemo(
    () => ({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      status: "draft",
      visibility: "public",
      is_featured: false,
      is_recurring: false,
      check_in_radius: 30,
      category_ids: [],
      primary_category_id: undefined,
      media_items: [],
      start_time: "",
      end_time: "",
      full_description: "",
      ...defaultValues,
    }),
    [defaultValues]
  )

  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventFormSchema),
    defaultValues: resolvedDefaultValues,
  })

  useEffect(() => {
    form.reset(resolvedDefaultValues)
  }, [form, resolvedDefaultValues])

  const mediaFieldArray = useFieldArray({
    control: form.control,
    name: "media_items",
  })

  const [isUploadingCover, setIsUploadingCover] = useState(false)
  const [mediaUploads, setMediaUploads] = useState<Record<number, boolean>>({})
  const coverPreviewUrl = form.watch("cover_image_url")
  const mediaPreviewItems = form.watch("media_items") ?? []

  const requestPresignedUrl = async (file: File) => {
    const response = await fetch("/api/uploads/presigned-url", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type,
        folder: "events",
      }),
    })

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null)
      throw new Error(errorBody?.error || "Failed to request upload URL")
    }

    const payload = await response.json()
    if (!payload?.success || !payload?.data?.uploadUrl) {
      throw new Error(payload?.error || "Failed to get upload URL")
    }

    return payload.data as {
      uploadUrl: string
      publicUrl: string
    }
  }

  const uploadFile = async (file: File) => {
    const { uploadUrl, publicUrl } = await requestPresignedUrl(file)
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type,
      },
      body: file,
    })

    if (!uploadResponse.ok) {
      throw new Error("Failed to upload file")
    }

    return publicUrl
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Title</FormLabel>
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
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea placeholder="Event description" {...field} />
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
              <FormLabel>Full Description</FormLabel>
              <FormControl>
                <Textarea placeholder="Detailed event information" {...field} />
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
                <Input placeholder="Brief description" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="start_time"
            render={({ field }) => (
              <FormItem className="flex flex-col">
                <FormLabel>Start Date & Time</FormLabel>
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
              <FormItem className="flex flex-col">
                <FormLabel>End Date & Time</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
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
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="venue_name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Venue Name</FormLabel>
                <FormControl>
                  <Input placeholder="Venue name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="address"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Address</FormLabel>
                <FormControl>
                  <Input placeholder="Event address" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-4 gap-4">
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
                <FormLabel>State</FormLabel>
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

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="latitude"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Latitude</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="any"
                    placeholder="Latitude"
                    value={field.value ?? ""}
                    onChange={(event) =>
                      field.onChange(
                        event.target.value === "" ? undefined : Number(event.target.value)
                      )
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="longitude"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Longitude</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="any"
                    placeholder="Longitude"
                    value={field.value ?? ""}
                    onChange={(event) =>
                      field.onChange(
                        event.target.value === "" ? undefined : Number(event.target.value)
                      )
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="max_capacity"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Maximum Capacity</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  placeholder="Maximum number of attendees"
                  value={field.value ?? ""}
                  onChange={(event) =>
                    field.onChange(
                      event.target.value === "" ? undefined : Number(event.target.value)
                    )
                  }
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="current_capacity"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Current Capacity</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  placeholder="Current attendees count"
                  value={field.value ?? ""}
                  onChange={(event) =>
                    field.onChange(
                      event.target.value === "" ? undefined : Number(event.target.value)
                    )
                  }
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="check_in_radius"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Check-in Radius (meters)</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  placeholder="Check-in radius"
                  value={field.value ?? ""}
                  onChange={(event) =>
                    field.onChange(
                      event.target.value === "" ? undefined : Number(event.target.value)
                    )
                  }
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="cover_image_url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Cover Image URL</FormLabel>
              <div className="flex flex-col gap-2">
                <FormControl>
                  <Input placeholder="https://..." {...field} />
                </FormControl>
                <Input
                  type="file"
                  accept="image/*"
                  disabled={isUploadingCover}
                  onChange={async (event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    try {
                      setIsUploadingCover(true)
                      const publicUrl = await uploadFile(file)
                      form.setValue("cover_image_url", publicUrl, {
                        shouldValidate: true,
                      })
                      toast.success("Cover image uploaded")
                    } catch (error) {
                      console.error("Cover upload error:", error)
                      toast.error("Failed to upload cover image")
                    } finally {
                      setIsUploadingCover(false)
                      event.target.value = ""
                    }
                  }}
                />
                {coverPreviewUrl && (
                  <img
                    src={coverPreviewUrl}
                    alt="Cover preview"
                    className="max-h-48 w-full rounded-md border object-cover"
                  />
                )}
              </div>
              <FormMessage />
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
                <Input placeholder="https://..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="timezone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Timezone</FormLabel>
              <FormControl>
                <Input placeholder="Timezone" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="is_featured"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <FormLabel>Featured</FormLabel>
                  <div className="text-muted-foreground text-sm">
                    Highlight this event.
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
            name="is_recurring"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <FormLabel>Recurring</FormLabel>
                  <div className="text-muted-foreground text-sm">
                    This event repeats.
                  </div>
                </div>
                <FormControl>
                  <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="house_rules"
            render={({ field }) => (
              <FormItem>
                <FormLabel>House Rules</FormLabel>
                <FormControl>
                  <Textarea placeholder="Rules for attendees" {...field} />
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
                  <Textarea placeholder="Cancellation policy" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="additional_info"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Additional Info (JSON)</FormLabel>
                <FormControl>
                  <Textarea placeholder='{"key": "value"}' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="faq"
            render={({ field }) => (
              <FormItem>
                <FormLabel>FAQ (JSON)</FormLabel>
                <FormControl>
                  <Textarea placeholder='[{"q": "...", "a": "..."}]' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="accessibility_info"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Accessibility Info (JSON)</FormLabel>
                <FormControl>
                  <Textarea placeholder='{"wheelchair": true}' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="covid_guidelines"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Covid Guidelines</FormLabel>
                <FormControl>
                  <Textarea placeholder="Covid guidelines" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="category_ids"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Categories</FormLabel>
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-2">
                  {categories.length === 0 && (
                    <p className="text-muted-foreground text-sm">
                      No categories available.
                    </p>
                  )}
                  {categories.map((category) => {
                    const checked = field.value?.includes(category.id) ?? false
                    return (
                      <label
                        key={category.id}
                        className="flex items-center gap-2 rounded-md border p-2 text-sm"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(value) => {
                            const next = field.value ? [...field.value] : []
                            if (value) {
                              next.push(category.id)
                              if (!form.getValues("primary_category_id")) {
                                form.setValue("primary_category_id", category.id, {
                                  shouldValidate: true,
                                })
                              }
                            } else {
                              const updated = next.filter((id) => id !== category.id)
                              if (form.getValues("primary_category_id") === category.id) {
                                form.setValue(
                                  "primary_category_id",
                                  updated[0],
                                  { shouldValidate: true }
                                )
                              }
                              field.onChange(updated)
                              return
                            }
                            field.onChange(next)
                          }}
                        />
                        {category.name}
                      </label>
                    )
                  })}
                </div>

                {field.value && field.value.length > 0 && (
                  <div className="space-y-2 rounded-md border p-3">
                    <p className="text-sm font-medium">Selected order</p>
                    <div className="space-y-2">
                      {field.value.map((categoryId, index) => {
                        const category = categories.find((item) => item.id === categoryId)
                        if (!category) return null
                        const primaryId = form.getValues("primary_category_id")
                        return (
                          <div
                            key={categoryId}
                            className="flex items-center gap-2 rounded-md border px-2 py-1"
                          >
                            <input
                              type="radio"
                              name="primary_category_id"
                              className="h-4 w-4"
                              checked={primaryId === categoryId}
                              onChange={() =>
                                form.setValue("primary_category_id", categoryId, {
                                  shouldValidate: true,
                                })
                              }
                            />
                            <span className="text-sm">{category.name}</span>
                            <div className="ml-auto flex items-center gap-1">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={index === 0}
                                onClick={() => {
                                  const next = [...field.value]
                                  const [removed] = next.splice(index, 1)
                                  next.splice(index - 1, 0, removed)
                                  field.onChange(next)
                                }}
                              >
                                Up
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={index === field.value.length - 1}
                                onClick={() => {
                                  const next = [...field.value]
                                  const [removed] = next.splice(index, 1)
                                  next.splice(index + 1, 0, removed)
                                  field.onChange(next)
                                }}
                              >
                                Down
                              </Button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      Select the radio button to mark a primary category.
                    </p>
                  </div>
                )}
              </div>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <FormLabel>Media Items</FormLabel>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                mediaFieldArray.append({
                  type: "image",
                  url: "",
                  thumbnail_url: "",
                  title: "",
                  description: "",
                  order: mediaFieldArray.fields.length,
                })
              }
            >
              Add Media
            </Button>
          </div>
          {mediaFieldArray.fields.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No media items added yet.
            </p>
          )}
          {mediaFieldArray.fields.map((fieldItem, index) => (
            <div key={fieldItem.id} className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Media #{index + 1}</span>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => mediaFieldArray.remove(index)}
                >
                  Remove
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-4">
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
                  name={`media_items.${index}.order`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Order</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          value={field.value ?? index}
                          onChange={(event) =>
                            field.onChange(
                              event.target.value === ""
                                ? undefined
                                : Number(event.target.value)
                            )
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name={`media_items.${index}.url`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>URL</FormLabel>
                    <div className="flex flex-col gap-2">
                      <FormControl>
                        <Input placeholder="https://..." {...field} />
                      </FormControl>
                      <Input
                        type="file"
                        disabled={mediaUploads[index]}
                        onChange={async (event) => {
                          const file = event.target.files?.[0]
                          if (!file) return
                          try {
                            setMediaUploads((prev) => ({ ...prev, [index]: true }))
                            const publicUrl = await uploadFile(file)
                            form.setValue(`media_items.${index}.url`, publicUrl, {
                              shouldValidate: true,
                            })
                            const currentType = form.getValues(
                              `media_items.${index}.type`
                            )
                            const currentThumb = form.getValues(
                              `media_items.${index}.thumbnail_url`
                            )
                            if (currentType === "image" && !currentThumb) {
                              form.setValue(
                                `media_items.${index}.thumbnail_url`,
                                publicUrl,
                                { shouldValidate: true }
                              )
                            }
                            toast.success("Media uploaded")
                          } catch (error) {
                            console.error("Media upload error:", error)
                            toast.error("Failed to upload media")
                          } finally {
                            setMediaUploads((prev) => ({ ...prev, [index]: false }))
                            event.target.value = ""
                          }
                        }}
                      />
                      {mediaPreviewItems[index]?.url && (
                        <>
                          {mediaPreviewItems[index]?.type === "image" ? (
                            <img
                              src={mediaPreviewItems[index].url}
                              alt={`Media ${index + 1}`}
                              className="max-h-48 w-full rounded-md border object-cover"
                            />
                          ) : (
                            <p className="text-muted-foreground text-xs">
                              Preview available for images only.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name={`media_items.${index}.thumbnail_url`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Thumbnail URL</FormLabel>
                    <FormControl>
                      <Input placeholder="https://..." {...field} />
                    </FormControl>
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
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name={`media_items.${index}.description`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Input placeholder="Description" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>
          ))}
        </div>

        <Button type="submit" disabled={isSubmitting}>
          {submitLabel}
        </Button>
      </form>
    </Form>
  )
}
