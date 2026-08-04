import { z } from "zod"

export const sendMessageSchema = z.object({
  content: z.string().min(1, "Message cannot be empty").max(2000, "Message is too long"),
  type: z.enum(["text", "image", "video"]).default("text"),
  parentId: z.string().uuid().optional(), // For replies
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const chatQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(), // Get messages before this timestamp
  after: z.string().datetime().optional(), // Get messages after this timestamp
})

export type SendMessageInput = z.infer<typeof sendMessageSchema>
export type ChatQueryInput = z.infer<typeof chatQuerySchema>
