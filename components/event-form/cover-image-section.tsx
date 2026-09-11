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
import { DevicePreview } from "@/components/event-form/device-preview"
import { renderableImageUrl } from "@/components/event-form/publish-rail"
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
  // Only a URL that parses is drawn; the field is typed a character at a time.
  const coverPreviewUrl = renderableImageUrl(form.watch("cover_image_url"))

  return (
    <FormField
      control={form.control}
      name="cover_image_url"
      render={({ field }) => (
        <FormItem>
          <FormLabel>
            Cover{" "}
            <span className="font-normal text-muted-foreground">
              · square, 2048 × 2048 recommended, 1600 × 1600 at least — the cards crop to squares
            </span>
          </FormLabel>
          <div className="grid gap-4 @2xl/main:grid-cols-[132px_minmax(0,1fr)]">
            {coverPreviewUrl ? (
              <Image
                src={coverPreviewUrl}
                alt="Cover preview"
                width={132}
                height={132}
                unoptimized
                className="aspect-square w-[132px] rounded-lg border object-cover"
              />
            ) : (
              <div className="grid aspect-square w-[132px] place-items-center rounded-lg border border-dashed border-border-strong text-[0.75rem] text-muted-foreground">
                No cover
              </div>
            )}
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center gap-2">
                <Input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={isUploadingCover}
                  className="cursor-pointer"
                  aria-label="Upload a cover image"
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
                {coverPreviewUrl ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => form.setValue("cover_image_url", "")}>
                    Remove
                  </Button>
                ) : null}
              </div>
              {isUploadingCover ? (
                <div className="flex items-center gap-2">
                  <Progress value={coverUploadProgress} className="h-2 flex-1" />
                  <span className="w-10 text-right text-xs text-muted-foreground">{coverUploadProgress}%</span>
                </div>
              ) : null}
              <FormControl>
                <Input placeholder="…or paste an image URL" {...field} value={field.value || ""} aria-label="Cover image URL" />
              </FormControl>
              <FormMessage />
            </div>
          </div>
          {/* The three crops, only once there is something to crop. */}
          {coverPreviewUrl ? <DevicePreview src={coverPreviewUrl} /> : null}
        </FormItem>
      )}
    />
  )
}
