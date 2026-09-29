import { SPONSORSHIP } from "./constants"
import type { UploadFolder } from "./tigris"

/*
 * What each upload folder accepts: the content types and the size ceiling.
 * Split out of `lib/tigris.ts` (SCRUM-427) to keep that file about storage.
 */

/**
 * Validate content type for uploads
 */
export function validateContentType(contentType: string, folder: UploadFolder): boolean {
  const allowedTypes: Record<UploadFolder, string[]> = {
    profile: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    chat: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "video/mp4",
      "video/quicktime",
      "audio/mpeg",
      "audio/mp4",
    ],
    /*
     * `video/mp4` because an event gallery has always been able to hold a clip
     * and could never receive one.
     *
     * The Gallery offers Type = Video, its file input accepts `video/mp4`, the
     * help text specifies the encode down to faststart, `media-section.tsx`
     * says "video has always been supported here", the seed attaches clips to
     * two events, and the app's feed card cycles them. The only thing that said
     * otherwise was this list, which had no comment — the one below it is about
     * `sponsored`. So every organiser upload 400'd at the presigned-url step
     * and the clip could only ever arrive by pasting a URL.
     *
     * The 20MB ceiling in `getMaxFileSize` was already sized for video; images
     * are capped at 8MB by the form's own copy.
     */
    events: ["image/jpeg", "image/png", "image/webp", "video/mp4"],
    /*
     * Deliberately narrower than `chat`, which allows GIF, QuickTime and audio.
     *
     * An animated GIF in a room is a loop nobody can stop. QuickTime does not
     * play inline on Android. Audio has no poster frame, so it cannot be
     * rendered as anything a person can decline to open. Sponsored media is the
     * one kind an attendee did not choose to receive, so the format has to be
     * one every phone plays inline, muted, on demand.
     */
    sponsored: ["image/jpeg", "image/png", "image/webp", "video/mp4"],
    // A scan or a photo of a licence; nothing that plays.
    claims: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  }

  return allowedTypes[folder]?.includes(contentType) ?? false
}

/**
 * Get maximum file size for a folder (in bytes)
 */
export function getMaxFileSize(folder: UploadFolder): number {
  const maxSizes: Record<UploadFolder, number> = {
    profile: 10 * 1024 * 1024, // 10MB
    chat: 50 * 1024 * 1024, // 50MB
    events: 20 * 1024 * 1024, // 20MB
    // The ceiling for the folder. `lib/upload-grant-actions.ts` narrows it
    // further per content type — an image has no business being 100MB.
    sponsored: SPONSORSHIP.MAX_VIDEO_BYTES,
    claims: 20 * 1024 * 1024, // 20MB
  }

  return maxSizes[folder] ?? 10 * 1024 * 1024
}
