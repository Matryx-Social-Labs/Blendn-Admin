"use client"

import { useId, useRef, useState } from "react"
import type { UseFieldArrayReturn, UseFormReturn } from "react-hook-form"
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Button } from "@/components/ui/button"
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  IconGripVertical,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react"
import { MediaFitPreview } from "@/components/event-form/media-fit-preview"
import { ClipCheckLine, ClipStills } from "@/components/event-form/clip-check"
import type { ClipCheckState } from "@/components/event-form/check-clip"
import { FormSection } from "@/components/event-form/form-section"
import { httpsUrl } from "@/lib/https-url"
import type { EventFormValues } from "@/components/event-form/schema"

/**
 * What the file picker will offer, per media type.
 *
 * It offered everything before, so a `.mov` could be attached to an item typed
 * `image` and the failure only showed up in the app. These mirror the formats
 * `docs/MEDIA.md` commits to — narrower than what the storage bucket accepts,
 * deliberately, because the constraint that matters is what the phone decodes.
 */
const ACCEPT: Record<string, string> = {
  image: "image/jpeg,image/png,image/webp",
  video: "video/mp4",
  document: "application/pdf",
}

/** Checking clips with the media worker; null while it is off, and then none of it is drawn. */
interface ClipChecks {
  /** By the item's id. */
  checks: Record<string, ClipCheckState>
  /** `newClip`: the link just changed, so its opening frame becomes the poster. */
  onCheck: (itemId: string, newClip: boolean) => void
  onForget: (itemId: string) => void
}

// ── Sortable media item ───────────────────────────────────────────────────────

function SortableMediaItem({
  fieldItem,
  index,
  form,
  onRemove,
  uploadProgress,
  onUpload,
  clips,
}: {
  fieldItem: { id: string }
  index: number
  form: UseFormReturn<EventFormValues>
  onRemove: () => void
  uploadProgress: number | undefined
  /** Resolves to why the file was refused, shown beside the input, or null. */
  onUpload: (file: File, itemId: string) => Promise<string | null>
  clips: ClipChecks | null
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: fieldItem.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  /*
   * Inline, not a toast: the organizer has to go and trim the clip, so the
   * reason stays beside the input until the next pick or a change of type
   * (decided per advisor, SCRUM-1066). Local to the item, so it follows a
   * reorder and goes with a removal.
   */
  const [refusal, setRefusal] = useState<string | null>(null)
  const refusalId = useId()

  /** The URL was typed over since it was last checked: checked when the field is left, or the type becomes Video. */
  const typed = useRef(false)

  const isUploading = uploadProgress !== undefined
  const previewUrl = form.watch(`media_items.${index}.url`)
  const mediaType = form.watch(`media_items.${index}.type`)
  const thumbnail = form.watch(`media_items.${index}.thumbnail_url`)
  const width = form.watch(`media_items.${index}.width`)
  const height = form.watch(`media_items.${index}.height`)
  const focalX = form.watch(`media_items.${index}.focal_x`)
  const focalY = form.watch(`media_items.${index}.focal_y`)
  const durationMs = form.watch(`media_items.${index}.duration_ms`)
  const renditions = form.watch(`media_items.${index}.renditions`)
  const clipRefusal = form.watch(`media_items.${index}.clip_refusal`)
  const itemId = form.watch(`media_items.${index}.id`)
  const clipState = itemId ? clips?.checks[itemId] : undefined

  const checkTyped = () => {
    const item = form.getValues(`media_items.${index}`)
    if (!clips || !item || !typed.current || item.type !== "video" || !httpsUrl().safeParse(item.url).success) return
    typed.current = false
    clips.onCheck(item.id, true)
  }

  return (
    <div ref={setNodeRef} style={style} className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-auto cursor-grab touch-none p-1 text-muted-foreground hover:text-foreground"
            aria-label={`Reorder media item ${index + 1}`}
            {...attributes}
            {...listeners}
          >
            <IconGripVertical className="size-5" />
          </Button>
          <span className="text-sm font-medium">Media #{index + 1}</span>
        </div>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={onRemove}
          aria-label={`Remove media item ${index + 1}`}
        >
          <IconTrash className="size-4" />
        </Button>
      </div>

      <FormField
        control={form.control}
        name={`media_items.${index}.type`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Type</FormLabel>
            <Select
              onValueChange={(value) => {
                setRefusal(null)
                field.onChange(value)
                // A refusal is about the clip: an image has none.
                form.clearErrors(`media_items.${index}.url`)
                checkTyped()
              }}
              value={field.value}
            >
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
                <Input
                  placeholder="https://…"
                  {...field}
                  onBlur={() => {
                    field.onBlur()
                    checkTyped()
                  }}
                  onChange={(e) => {
                    typed.current = true
                    // A typed URL is another file: the measured size was the upload's (SCRUM-1066).
                    form.setValue(`media_items.${index}.width`, undefined)
                    form.setValue(`media_items.${index}.height`, undefined)
                    form.setValue(`media_items.${index}.duration_ms`, undefined)
                    // …and so was its subject (SCRUM-1106).
                    form.setValue(`media_items.${index}.focal_x`, undefined)
                    form.setValue(`media_items.${index}.focal_y`, undefined)
                    form.setValue(`media_items.${index}.renditions`, undefined)
                    form.setValue(`media_items.${index}.clip_refusal`, undefined)
                    if (itemId) clips?.onForget(itemId)
                    // Last: the change revalidates, and the old link's refusal must be gone by then.
                    form.clearErrors(`media_items.${index}.url`)
                    field.onChange(e)
                  }}
                />
              </FormControl>
              <Input
                type="file"
                disabled={isUploading}
                aria-invalid={refusal ? true : undefined}
                aria-describedby={refusal ? refusalId : undefined}
                accept={mediaType ? ACCEPT[mediaType] : undefined}
                onChange={async (e) => {
                  const input = e.target
                  const file = input.files?.[0]
                  if (!file) return
                  setRefusal(null)
                  const itemId = form.getValues(`media_items.${index}.id`)
                  if (!itemId) return
                  typed.current = false
                  clips?.onForget(itemId)
                  const reason = await onUpload(file, itemId)
                  input.value = ""
                  setRefusal(reason)
                }}
              />
              {refusal && (
                <p id={refusalId} role="alert" className="text-sm text-destructive">
                  {refusal}
                </p>
              )}
              {/* Beside the inputs, not under the previews: a refused clip's reason is here too. */}
              <FormMessage />
              {clips && itemId && mediaType === "video" && previewUrl && (
                <ClipCheckLine
                  state={clipState}
                  stored={renditions?.length && width && height && durationMs ? { width, height, durationMs } : null}
                  refused={Boolean(clipRefusal)}
                  onCheck={() => clips.onCheck(itemId, clipState?.kind === "failed" && clipState.newClip)}
                />
              )}
              {/*
                The spec for the type actually chosen, next to the control that
                needs it. It used to sit at the top of the section — both specs,
                before the first control, which is where a form starts reading
                like a manual. `faststart` keeps its reason because that reason
                is the whole point of the requirement.
              */}
              {mediaType === "image" && (
                <p className="text-xs text-muted-foreground">
                  Square, 2048 × 2048 (1600 × 1600 minimum) · JPEG or PNG · up to 8 MB
                </p>
              )}
              {mediaType === "video" && (
                <p className="text-xs text-muted-foreground">
                  Square, 1080 × 1080 · 15 seconds · MP4 (H.264 + AAC) · up to 12 MB.
                  Export with <strong>faststart</strong>, or the clip waits for the
                  whole file before it plays.
                </p>
              )}
              {isUploading && (
                <div className="flex items-center gap-2">
                  <Progress value={uploadProgress} className="h-2 flex-1" />
                  <span className="text-xs text-muted-foreground w-10 text-right">
                    {uploadProgress}%
                  </span>
                </div>
              )}
              {/*
                Video keeps its player: the only way to find out whether a pasted
                URL plays, short of publishing. Muted, metadata only.
              */}
              {previewUrl && mediaType === "video" && (
                <video
                  src={previewUrl}
                  controls
                  muted
                  playsInline
                  preload="metadata"
                  className="max-h-40 w-full rounded-md border bg-muted object-contain"
                />
              )}
              {/*
                The upload in the app's five cards, and where its subject is
                (SCRUM-1106). A gallery image is not a detail-page extra: the
                feed cycles the whole set on an active card.
              */}
              {previewUrl && (mediaType === "image" || mediaType === "video") && (
                <MediaFitPreview
                  src={previewUrl}
                  type={mediaType}
                  poster={mediaType === "video" ? thumbnail || null : null}
                  size={width && height ? { width, height } : null}
                  focal={focalX != null && focalY != null ? { x: focalX, y: focalY } : null}
                  onFocalChange={(point) => {
                    form.setValue(`media_items.${index}.focal_x`, point?.x, { shouldDirty: true })
                    form.setValue(`media_items.${index}.focal_y`, point?.y, { shouldDirty: true })
                  }}
                />
              )}
            </div>
          </FormItem>
        )}
      />

      {/*
        The poster, and only for video.
        A clip's still is its own `thumbnail_url` and never the event's cover
        (SCRUM-1066): the app shows a dark frame until a clip without one plays,
        which is what the help below says.
      */}
      {mediaType === "video" && (
        <FormField
          control={form.control}
          name={`media_items.${index}.thumbnail_url`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Poster image</FormLabel>
              <FormControl>
                <Input placeholder="https://…" {...field} value={field.value || ""} />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                Filled in automatically from the clip&apos;s first frame when you
                upload a file — leave it alone and the clip will start without a
                visible jump. Uploading another file replaces it. Set it yourself only if
                you want a different still, and prefer a frame from the clip: a poster that is a
                different picture visibly swaps the moment the video starts.
                <br />
                {clips
                  ? "For a clip added by URL, it is filled in when the clip is checked. "
                  : "For a clip added by URL we cannot read the frame, so paste a poster here. "}
                <strong>With no poster, the clip shows a dark frame until it plays.</strong>
              </p>
              {clipState?.kind === "done" && clipState.stills.length > 0 && (
                <ClipStills
                  stills={clipState.stills}
                  value={field.value || ""}
                  onPick={(url) => form.setValue(`media_items.${index}.thumbnail_url`, url, { shouldDirty: true })}
                />
              )}
              <FormMessage />
            </FormItem>
          )}
        />
      )}

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

export function MediaSection({
  form,
  mediaFieldArray,
  mediaUploadProgress,
  onUpload,
  clips,
}: {
  form: UseFormReturn<EventFormValues>
  mediaFieldArray: UseFieldArrayReturn<EventFormValues, "media_items">
  /** By the item's id (`media_items[].id`), not its index. */
  mediaUploadProgress: Record<string, number>
  /** Resolves to why the file was refused, shown beside the input, or null. */
  onUpload: (file: File, itemId: string) => Promise<string | null>
  clips: ClipChecks | null
}) {
  const sensors = useSensors(useSensor(PointerSensor))

  return (
    <FormSection title="Gallery" level={3}>
      {/*
        This said "additional images shown on the event detail page", which
        undersold it twice: video has always been supported here, and the app
        cycles this whole set on the home feed card once a card is active — so
        the first item is what most people see, not a detail-page extra.
      */}
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Images and clips for this event. The home feed cycles through them
          while the card is on screen, so <strong>order matters</strong> — drag
          to reorder. Square works best: every card crops to a square.
        </p>
      </div>
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
                uploadProgress={mediaUploadProgress[form.getValues(`media_items.${index}.id`) ?? ""]}
                onUpload={onUpload}
                clips={clips}
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
  )
}
