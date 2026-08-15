"use client"

import Image from "next/image"
import type { UseFormReturn } from "react-hook-form"
import { toast } from "sonner"
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
import { FormSection } from "@/components/event-form/form-section"
import { uploadFile } from "@/components/event-form/upload"
import type { EventFormValues } from "@/components/event-form/schema"

export function CoverImageSection({
  form,
  isUploadingCover,
  setIsUploadingCover,
  coverUploadProgress,
  setCoverUploadProgress,
}: {
  form: UseFormReturn<EventFormValues>
  isUploadingCover: boolean
  setIsUploadingCover: (v: boolean) => void
  coverUploadProgress: number
  setCoverUploadProgress: (v: number) => void
}) {
  const coverPreviewUrl = form.watch("cover_image_url")

  return (
    <FormSection title="Cover Image" defaultOpen={true}>
      {/*
        This said "Recommended 1200×630 px" — a landscape OG-image ratio, and
        flatly wrong for this product. Every card slot crops from a square
        master (see docs/MEDIA.md), so a 1200×630 upload loses its left and
        right edges on the feed and is upscaled on the hero card, which is the
        most visible quality failure we have.
      */}
      <p className="text-sm text-muted-foreground">
        Shown on every event card, and used as the fallback poster for any clip
        in the gallery. <strong>Square, 2048 × 2048 recommended</strong> (1600 ×
        1600 minimum) — the cards crop to squares, so keep the subject centred.
      </p>
      <FormField
        control={form.control}
        name="cover_image_url"
        render={({ field }) => (
          <FormItem>
            <div className="flex flex-col gap-3">
              {coverPreviewUrl ? (
                <div className="relative">
                  <Image
                    src={coverPreviewUrl}
                    alt="Cover preview"
                    width={1200}
                    height={192}
                    unoptimized
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
                      setCoverUploadProgress(0)
                      const url = await uploadFile(file, setCoverUploadProgress)
                      form.setValue("cover_image_url", url, { shouldValidate: true })
                      toast.success("Cover image uploaded")
                    } catch {
                      toast.error("Failed to upload cover image")
                    } finally {
                      setIsUploadingCover(false)
                      setCoverUploadProgress(0)
                      e.target.value = ""
                    }
                  }}
                />
                {isUploadingCover && (
                  <span className="text-sm text-muted-foreground">Uploading…</span>
                )}
              </div>

              {isUploadingCover && (
                <div className="flex items-center gap-2">
                  <Progress value={coverUploadProgress} className="h-2 flex-1" />
                  <span className="text-xs text-muted-foreground w-10 text-right">
                    {coverUploadProgress}%
                  </span>
                </div>
              )}

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
  )
}
