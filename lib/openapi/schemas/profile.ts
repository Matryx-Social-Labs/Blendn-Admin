import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { PaginationMetaSchema } from "./common"

// Request schemas
export const UpdateProfileRequestSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    phone: z.string().max(20).optional().nullable(),
    age: z.number().int().min(13).max(120).optional().nullable(),
    location: z.string().max(200).optional().nullable(),
    bio: z.string().max(500).optional().nullable(),
    occupation: z.string().max(100).optional().nullable(),
    education: z.string().max(100).optional().nullable(),
    interests: z.array(z.string()).optional(),
    photos: z.array(z.string().url()).max(6).optional(),
    onboarded: z.boolean().optional(),
  })
  .openapi("UpdateProfileRequest")

export const InterestCategoryIdsSchema = z
  .object({
    categoryIds: z.array(z.string().uuid()).min(1),
  })
  .openapi("InterestCategoryIds")

// Response schemas
const InterestSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable().optional(),
  icon: z.string().nullable(),
  addedAt: z.string().datetime().optional(),
})

export const ProfileResponseSchema = z
  .object({
    id: z.string(),
    email: z.string().email(),
    name: z.string(),
    image: z.string().nullable(),
    createdAt: z.string().datetime(),
    profile: z.object({
      id: z.string().uuid(),
      phone: z.string().nullable(),
      age: z.number().nullable(),
      location: z.string().nullable(),
      bio: z.string().nullable(),
      occupation: z.string().nullable(),
      education: z.string().nullable(),
      photos: z.array(z.string()).nullable(),
      onboarded: z.boolean(),
    }).nullable(),
    interests: z.array(InterestSchema),
  })
  .openapi("ProfileResponse")

export const InterestsResponseSchema = z
  .object({
    interests: z.array(InterestSchema),
  })
  .openapi("InterestsResponse")

export const UserPublicProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    photos: z.array(z.string()),
    age: z.number().nullable(),
    location: z.string().nullable(),
    bio: z.string().nullable(),
    occupation: z.string().nullable(),
    education: z.string().nullable(),
    interests: z.array(InterestSchema),
    memberSince: z.string().datetime(),
    stats: z.object({
      eventsAttended: z.number(),
      eventsFavorited: z.number(),
      eventsOrganized: z.number(),
    }),
    isOwnProfile: z.boolean(),
  })
  .openapi("UserPublicProfile")

export const UserFavoritesResponseSchema = z
  .object({
    events: z.array(z.unknown()),
    timeFilter: z.string(),
    pagination: PaginationMetaSchema,
  })
  .openapi("UserFavoritesResponse")

// Message request schemas
export const MessageRequestCreateSchema = z
  .object({
    recipientId: z.string().uuid(),
    message: z.string().max(500).optional(),
  })
  .openapi("MessageRequestCreate")

export const MessageRequestRespondSchema = z
  .object({
    action: z.enum(["accept", "decline", "block"]),
  })
  .openapi("MessageRequestRespond")

export const MessageRequestSchema = z
  .object({
    id: z.string().uuid(),
    senderId: z.string().optional(),
    recipientId: z.string().optional(),
    sender: z.object({ id: z.string(), name: z.string(), avatar: z.string().nullable() }).optional(),
    recipient: z.object({ id: z.string(), name: z.string(), avatar: z.string().nullable() }).optional(),
    message: z.string().nullable(),
    status: z.string(),
    createdAt: z.string().datetime(),
  })
  .openapi("MessageRequest")

export const MessageRequestListResponseSchema = z
  .object({
    requests: z.array(MessageRequestSchema),
    totalCount: z.number(),
  })
  .openapi("MessageRequestListResponse")

export const MessageRequestRespondResponseSchema = z
  .object({
    success: z.literal(true),
    status: z.string(),
    conversationId: z.string().uuid().optional(),
    sender: z.object({ id: z.string(), name: z.string(), avatar: z.string().nullable() }),
  })
  .openapi("MessageRequestRespondResponse")

// Upload schemas
export const PresignedUrlRequestSchema = z
  .object({
    filename: z.string().max(255),
    contentType: z.string(),
    folder: z.enum(["profile", "chat", "events"]).default("profile"),
  })
  .openapi("PresignedUrlRequest")

export const PresignedUrlResponseSchema = z
  .object({
    uploadUrl: z.string().url(),
    publicUrl: z.string().url(),
    key: z.string(),
    maxSize: z.number(),
    expiresIn: z.number(),
  })
  .openapi("PresignedUrlResponse")

export const DeleteUploadRequestSchema = z
  .object({
    url: z.string().url(),
  })
  .openapi("DeleteUploadRequest")

// Notification schemas
export const NotificationTokenRequestSchema = z
  .object({
    token: z.string(),
    platform: z.enum(["ios", "android"]),
  })
  .openapi("NotificationTokenRequest")

// Category schema
export const CategorySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    parent_id: z.string().uuid().nullable(),
    children: z.array(z.unknown()).optional(),
    _count: z.object({
      events: z.number(),
      user_interests: z.number(),
    }).optional(),
  })
  .openapi("Category")

// Active checkins
export const ActiveCheckinSchema = z
  .object({
    id: z.string().uuid(),
    eventId: z.string().uuid(),
    checkInTime: z.string().datetime(),
    event: z.object({
      id: z.string().uuid(),
      title: z.string(),
      slug: z.string(),
      coverImageUrl: z.string().nullable(),
      startTime: z.string().datetime(),
      endTime: z.string().datetime(),
      venueName: z.string().nullable(),
      address: z.string().nullable(),
      city: z.string().nullable(),
      status: z.string(),
    }),
  })
  .openapi("ActiveCheckin")

// Register all
const schemas = {
  UpdateProfileRequest: UpdateProfileRequestSchema,
  InterestCategoryIds: InterestCategoryIdsSchema,
  ProfileResponse: ProfileResponseSchema,
  InterestsResponse: InterestsResponseSchema,
  UserPublicProfile: UserPublicProfileSchema,
  UserFavoritesResponse: UserFavoritesResponseSchema,
  MessageRequestCreate: MessageRequestCreateSchema,
  MessageRequestRespond: MessageRequestRespondSchema,
  MessageRequest: MessageRequestSchema,
  MessageRequestListResponse: MessageRequestListResponseSchema,
  MessageRequestRespondResponse: MessageRequestRespondResponseSchema,
  PresignedUrlRequest: PresignedUrlRequestSchema,
  PresignedUrlResponse: PresignedUrlResponseSchema,
  DeleteUploadRequest: DeleteUploadRequestSchema,
  NotificationTokenRequest: NotificationTokenRequestSchema,
  Category: CategorySchema,
  ActiveCheckin: ActiveCheckinSchema,
}

for (const [name, schema] of Object.entries(schemas)) {
  registry.register(name, schema)
}
