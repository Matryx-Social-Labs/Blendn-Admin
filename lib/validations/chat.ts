import { z } from "zod"
import { ownedObjectKey, sealUpload, type SealRefusal } from "@/lib/tigris"

/**
 * What a client may put in a room message's `metadata`: its own media, and
 * nothing else (SCRUM-426).
 *
 * It was a free record, stored verbatim, and the app draws any message whose
 * metadata has `sponsored_message_id` as a sponsored card, so an attendee could
 * post one. The server's own writers (the sponsored scheduler, broadcasts) set
 * metadata on the row themselves and never come through this.
 */
export const clientMessageMetadata = z.object({ mediaUrl: z.string().url().optional() }).strict()

/** Said when a message's media is not the sender's own upload. */
export const NOT_OWN_MEDIA = "Send photos through the app rather than linking to them"

/**
 * A message's media is the sender's own `chat/<id>/` upload on our bucket
 * (SCRUM-426): not somebody else's, and not any URL on the internet for the
 * recipient's phone to fetch.
 */
export function isOwnChatMedia(url: string, userId: string): boolean {
  return ownedObjectKey(url, userId, "chat") !== null
}

const SEAL_REFUSAL: Record<SealRefusal, string> = {
  missing: "That photo did not finish uploading. Try again.",
  too_small: "That photo is empty. Try again.",
  too_large: "That file is too large to send.",
  wrong_type: "That kind of file can't be sent.",
}

/**
 * The sender's upload as a message stores it: its sealed copy (SCRUM-425),
 * which nobody holds an upload URL for, so it cannot change after it was
 * sent and moderated. Call after `isOwnChatMedia` and after a retry is
 * answered, so a refused or retried send does not copy anything.
 */
export async function sealChatMedia(url: string, userId: string): Promise<{ url: string } | { refusal: string }> {
  const key = ownedObjectKey(url, userId, "chat")
  if (!key) return { refusal: NOT_OWN_MEDIA }
  const sealed = await sealUpload(key, "chat", userId)
  return "refused" in sealed ? { refusal: SEAL_REFUSAL[sealed.refused] } : { url: sealed.url }
}

export const sendMessageSchema = z.object({
  content: z.string().min(1, "Message cannot be empty").max(2000, "Message is too long"),
  type: z.enum(["text", "image", "video"]).default("text"),
  parentId: z.string().uuid().optional(), // For replies
  /** The app's own id for this send: a retry with it returns the first write (SCRUM-410). */
  clientId: z.string().uuid().optional(),
  metadata: clientMessageMetadata.optional(),
})

export const chatQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(), // Get messages before this timestamp
  after: z.string().datetime().optional(), // Get messages after this timestamp
})

export type SendMessageInput = z.infer<typeof sendMessageSchema>
export type ChatQueryInput = z.infer<typeof chatQuerySchema>
