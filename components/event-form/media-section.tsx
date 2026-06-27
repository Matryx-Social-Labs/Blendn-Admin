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
import { FormSection } from "@/components/event-form/form-section"
import type { EventFormValues } from "@/components/event-form/schema"

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
            {...attributes}
            {...listeners}
          >
            <IconGripVertical className="size-5" />
          </Button>
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
              {isUploading && (
                <div className="flex items-center gap-2">
                  <Progress value={uploadProgress} className="h-2 flex-1" />
                  <span className="text-xs text-muted-foreground w-10 text-right">
                    {uploadProgress}%
                  </span>
                </div>
              )}
              {previewUrl && mediaType === "image" && (
                <Image
                  src={previewUrl}
                  alt={`Media ${index + 1}`}
                  width={800}
                  height={160}
                  unoptimized
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
