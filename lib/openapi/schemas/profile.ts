import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { PaginationMetaSchema } from "./common"

/**
 * These mirror `lib/validations/profile.ts`, and a test holds them to it.
 *
 * They drifted silently once: the spec was six fields behind the route --
 * `goals`, `looking_for` and the four preference booleans -- so the client
 * coding against `/api-docs` sent key names the route ignores and every
 * settings toggle persisted nothing. `openapi-coverage.test.ts` verified that
 * every *path* was documented, which is exactly why a missing *field* got
 * through; it now compares this body against the validator's own keys.
 *
 * Importing the validator directly would be better and does not survive the
 * build: `zod-to-openapi` patches the zod instance it is handed, Next gives the
 * two modules separate copies, and `.openapi()` is then missing from anything
 * built in `lib/validations`. Jest resolves modules differently and passes,
 * which is the worst version of this -- green locally, broken in CI. So the
 * duplication stays and the test is what makes it safe.
 */
export const UpdateProfileRequestSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    phone: z.string().max(20).optional().nullable(),
    age: z.number().int().min(13).max(120).optional().nullable(),

    // Write-only, and it supersedes `age` above wherever both exist. A stored
    // age is a snapshot that starts decaying the day it is taken; a birth date
    // is not. No response carries this back — not even to its owner — because
    // it is materially more identifying than the number derived from it.
    // Rejected outright if it does not parse, is in the future, or implies an
    // age outside 13–120.
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .openapi({ example: "1998-04-17", description: "YYYY-MM-DD. Write-only." }),

    location: z.string().max(200).optional().nullable(),
    bio: z.string().max(500).optional().nullable(),
    occupation: z.string().max(100).optional().nullable(),
    education: z.string().max(100).optional().nullable(),
    interests: z.array(z.string()).optional(),
    photos: z.array(z.string().url()).max(6).optional(),
    blur_photo: z
      .string()
      .url()
      .optional()
      .nullable()
      .openapi({
        description:
          "A 40px derivative of the primary photo, generated client-side by `createBlurDerivative`. Served ONLY to viewers who have not earned the real photos — the matched-but-unrevealed state. Never send the real URL with a blur applied in the app: the original then sits in the payload and the device cache, where the blur is undone in one step.",
      }),
    goals: z.array(z.string()).optional(),
    looking_for: z.array(z.string()).optional(),
    onboarded: z.boolean().optional(),

    /*
     * How you would like to enter a room: named, or as a pseudonym. Defaults
     * false, and it is a *suggestion* — check-in returns it as
     * `revealSuggestion` and still creates the row with `revealed: false`, so
     * being named remains a tap in the room rather than a setting that acts at
     * a distance.
     */
    reveal_by_default: z.boolean().optional(),

    // What this person is generally open to. The per-event override lives on
    // PUT /events/:eventId/matches/preferences; this is the default under it.
    intent_default: z
      .array(z.enum(["dating", "networking", "friendship", "just_here"]))
      .max(4)
      .optional(),

    // Matching inputs, never card content: these are returned to the owner and
    // to nobody else.
    gender: z.enum(["woman", "man", "non_binary", "prefer_not_to_say"]).optional().nullable(),
    interested_in: z
      .array(z.enum(["woman", "man", "non_binary", "prefer_not_to_say"]))
      .max(4)
      .optional(),

    /*
     * Show `orientation` to people who can already see who you are — matches,
     * open conversations, rooms you revealed yourself in. Not to everyone.
     *
     * Defaults false and stays false unless deliberately set: orientation is
     * special-category data under GDPR Article 9, so silence is not consent.
     * The second gate is `maySeeIdentity`, because a field more sensitive than
     * a name cannot be less protected than one.
     */
    show_orientation: z.boolean().optional(),

    /*
     * The labels they hold. `interested_in` is what matching reads; these are
     * only *sometimes* enough to derive it, so both are stored. Send
     * `interested_in` explicitly and it wins over derivation. Returned to its
     * owner always, and to others only under the two gates above.
     *
     * Up to three, distinct, and "prefer not to say" cannot be combined with
     * anything — declining to answer is not a fourth thing you are.
     * `interested_in` derives from the **union**, so adding a label never
     * narrows who you are shown.
     */
    orientations: z
      .array(
        z.enum([
          "straight",
          "gay",
          "lesbian",
          "bisexual",
          "pansexual",
          "queer",
          "asexual",
          "prefer_not_to_say",
        ])
      )
      .max(3)
      .optional(),

    // Deprecated, still accepted: writes a single label into `orientations`.
    // Kept because dropping it would make an old client's save succeed while
    // silently storing nothing. Send `orientations`.
    orientation: z
      .enum([
        "straight",
        "gay",
        "lesbian",
        "bisexual",
        "pansexual",
        "queer",
        "asexual",
        "prefer_not_to_say",
      ])
      .optional()
      .nullable(),

    // A slug from GET /work-fields, never free text — "Software" and
    // "software engineering" as two buckets is the mistake `interests` made.
    // Unlike the fields above this one is public: a coarse bucket is an
    // attribute, an employer is an address.
    work_field: z.string().optional().nullable(),

    // Top level, snake_case, no `preferences` wrapper and no camelCase alias.
    // The app was sending twelve variants of these four and matching none.
    push_enabled: z.boolean().optional(),
    show_online: z.boolean().optional(),
    read_receipts: z.boolean().optional(),
    share_location: z.boolean().optional(),
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
      goals: z.array(z.string()),
      looking_for: z.array(z.string()),
      work_field: z.string().nullable(),
      onboarded: z.boolean(),

      /*
       * Present for the owner, so the settings switch can render in the state
       * they left it. Present for others only when `show_orientation` is true
       * *and* the caller passes `maySeeIdentity` — absent, not null, so a
       * client cannot tell "withheld" from "not answered".
       */
      show_orientation: z.boolean().optional(),
      orientations: z.array(z.string()).optional(),

      // Read these back under `profile`, with these names. The client had been
      // looking for `shareReadReceipts` and falling back to `true`, so every
      // switch showed ON whatever the user had chosen.
      push_enabled: z.boolean(),
      show_online: z.boolean(),
      read_receipts: z.boolean(),
      share_location: z.boolean(),
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
    /**
     * Whether **you** are named in this room. Never anyone else's state — this
     * endpoint is scoped to the caller. Drives the status chip.
     */
    revealed: z.boolean(),
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
