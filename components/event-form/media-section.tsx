"use client"

import Image from "next/image"
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
import { DevicePreview } from "@/components/event-form/device-preview"
import { FormSection } from "@/components/event-form/form-section"
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

// ── Sortable media item ───────────────────────────────────────────────────────

function SortableMediaItem({
  fieldItem,
  index,
  form,
  onRemove,
  uploadProgress,
  onUpload,
}: {
  fieldItem: { id: string }
  index: number
  form: UseFormReturn<EventFormValues>
  onRemove: () => void
  uploadProgress: number | undefined
  onUpload: (file: File, index: number) => Promise<void>
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: fieldItem.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const isUploading = uploadProgress !== undefined
  const previewUrl = form.watch(`media_items.${index}.url`)
  const mediaType = form.watch(`media_items.${index}.type`)

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
                accept={mediaType ? ACCEPT[mediaType] : undefined}
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (file) await onUpload(file, index)
                  e.target.value = ""
                }}
              />
              {isUploading && (
                <div className="flex items-center gap-2">
                  <Progress value={uploadProgress} className="h-2 flex-1" />
                  <span className="text-xs text-muted-foreground w-10 text-right">
                    {uploadProgress}%
                  </span>
                </div>
              )}
              {previewUrl && mediaType === "image" && (
                <>
                  <Image
                    src={previewUrl}
                    alt={`Media ${index + 1}`}
                    width={800}
                    height={160}
                    unoptimized
                    className="max-h-40 w-full rounded-md border object-cover"
                  />
                  {/*
                    The same crops as the cover, because the feed cycles this
                    whole set on an active card — a gallery image is not a
                    detail-page extra, it is another thing that has to survive
                    the featured slot.
                  */}
                  <DevicePreview src={previewUrl} />
                </>
              )}
              {/*
                Video got no preview at all, so the only way to find out whether
                a pasted URL played was to publish the event and open the app.
                `muted` because a form that makes noise when you paste into it is
                hostile, and `preload="metadata"` so this costs a header rather
                than the clip.
              */}
              {previewUrl && mediaType === "video" && (
                <video
                  src={previewUrl}
                  controls
                  muted
                  playsInline
                  preload="metadata"
                  className="max-h-40 w-full rounded-md border bg-muted object-cover"
                />
              )}
            </div>
            <FormMessage />
          </FormItem>
        )}
      />

      {/*
        The poster, and only for video.
        `thumbnail_url` has been in the schema and on the write path the whole
        time with no input to fill it, so every clip an organiser added fell
        back to the event's cover image. The app's `feedClip` chain is
        thumbnail_url -> cover_image_url -> **drop the clip**, so a video on an
        event with no cover simply never played, and nothing here said so.
        Hence the warning below rather than a silent optional field.
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
                visible jump. Set it yourself only if you want a different
                still, and prefer a frame from the clip: a poster that is a
                different picture visibly swaps the moment the video starts.
                <br />
                For a clip added by URL we cannot read the frame, so paste a
                poster here. If it is empty the event&apos;s cover image is used
                — <strong>and if the event has no cover image either, the clip
                is not shown at all.</strong>
              </p>
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
}: {
  form: UseFormReturn<EventFormValues>
  mediaFieldArray: UseFieldArrayReturn<EventFormValues, "media_items">
  mediaUploadProgress: Record<number, number>
  onUpload: (file: File, index: number) => Promise<void>
}) {
  const sensors = useSensors(useSensor(PointerSensor))

  return (
    <FormSection title="Gallery" defaultOpen={false}>
      {/*
        This said "additional images shown on the event detail page", which
        undersold it twice: video has always been supported here, and the app
        cycles this whole set on the home feed card once a card is active — so
        the first item is what most people see, not a detail-page extra.
      */}
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Images and clips for this event. The card on the home feed cycles
          through them while it is on screen, so <strong>order matters</strong> —
          drag to reorder.
        </p>
        <p className="text-xs">
          <strong>Images</strong> — square, 2048 × 2048 recommended (1600 × 1600
          minimum), JPEG or PNG, up to 8 MB. The cards crop to squares, so
          anything landscape loses its edges.
          <br />
          <strong>Video</strong> — square, 1080 × 1080, 15 seconds or less, MP4
          (H.264 + AAC) with <strong>faststart</strong>, up to 12 MB. Without
          faststart the clip will not begin until the whole file has downloaded.
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
                uploadProgress={mediaUploadProgress[index]}
                onUpload={onUpload}
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
