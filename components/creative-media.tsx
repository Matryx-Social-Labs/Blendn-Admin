"use client"

import { useRef, useState, useTransition } from "react"
import { IconPaperclip } from "@tabler/icons-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { SPONSORSHIP } from "@/lib/constants"
import { attachCreativeMedia, requestCreativeUpload } from "@/lib/upload-grant-actions"

const ACCEPT = "image/jpeg,image/png,image/webp,video/mp4"

/**
 * Attach artwork to a sponsored campaign.
 *
 * Three steps, and the middle one does not go through this server: ask for a
 * grant, PUT straight to storage, then come back so the server can check what
 * actually arrived. Proxying the bytes through a Next route would put a 100MB
 * video through the request handler for no benefit — the server still has to
 * verify the object afterwards either way, because until the PUT lands the
 * client controls the content.
 */
export function CreativeMedia({
  eventId,
  campaignId,
  currentUrl,
  onAttached,
}: {
  eventId: string
  campaignId: string
  currentUrl?: string | null
  onAttached?: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function pick(file: File) {
    start(async () => {
      try {
        setProgress("Getting an upload slot…")
        const grant = await requestCreativeUpload(eventId, {
          filename: file.name,
          contentType: file.type,
          bytes: file.size,
        })

        setProgress("Uploading…")
        const res = await fetch(grant.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        })
        if (!res.ok) throw new Error("The upload did not finish")

        setProgress("Checking the file…")
        await attachCreativeMedia(campaignId, grant.key)

        /*
         * Says what it costs. Attaching artwork sends the campaign back to
         * review and switches it off, because the picture is the part an
         * attendee actually looks at and it has not been read by anyone.
         */
        toast.success("Attached. The campaign goes back for review before it runs.")
        onAttached?.()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not attach that file")
      } finally {
        setProgress(null)
        if (input.current) input.current.value = ""
      }
    })
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) pick(file)
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => input.current?.click()}
        >
          <IconPaperclip className="size-4 mr-1" />
          {currentUrl ? "Replace image or video" : "Add an image or video"}
        </Button>
        {progress ? (
          <span className="text-xs text-muted-foreground">{progress}</span>
        ) : null}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        JPEG, PNG, WebP or MP4. Up to {Math.round(SPONSORSHIP.MAX_IMAGE_BYTES / 1024 / 1024)}MB
        for an image, {Math.round(SPONSORSHIP.MAX_VIDEO_BYTES / 1024 / 1024)}MB for a video.
        {/*
          No GIF and no QuickTime, unlike attendee chat. An animated GIF is a
          loop nobody can stop, and QuickTime does not play inline on Android.
        */}
      </p>
      {currentUrl ? (
        <a
          href={currentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs underline underline-offset-4"
        >
          Current attachment
        </a>
      ) : null}
    </div>
  )
}
