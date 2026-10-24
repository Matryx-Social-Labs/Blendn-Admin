import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors, PageOrCursorQuerySchema, PagedPaginationSchema, UserRefParamSchema, wrap, bearerAuth, ROOM_BAN_GATE } from "@/lib/openapi/schemas/common"
import {
  UpdateProfileRequestSchema,
  InterestCategoryIdsSchema,
  ProfileResponseSchema,
  InterestsResponseSchema,
} from "@/lib/openapi/schemas/profile"
import { ChangedAtSchema, ChangedFieldsSchema, EventSessionSchema } from "@/lib/openapi/schemas/event"

// GET /api/mobile/profiles/{userId}
registry.registerPath({
  method: "get",
  path: "/api/mobile/profiles/{userId}",
  tags: ["Mobile Profiles"],
  summary: "Get user profile",
  description: ROOM_BAN_GATE +
    "`userId` may be a room handle (SCRUM-371). `id` and `profile.id` echo it as sent — `profiles.id` is the user id, so both are echoed — except on your own profile. A handle is answered in its room's terms: for somebody that room keeps anonymous the response is only `{ id, name, profile: { id, age, onboarded, location } }`, with `name` their pseudonym there. Your own profile carries `email` and the whole `profile` row but `date_of_birth`; anybody else's carries the subset `profile` describes.",
  security: bearerAuth,
  request: { params: z.object({ userId: UserRefParamSchema }) },
  responses: {
    200: { description: "Profile", content: { "application/json": { schema: wrap(ProfileResponseSchema) } } },
    ...standardErrors,
  },
})

// PUT /api/mobile/profiles/{userId}
registry.registerPath({
  method: "put",
  path: "/api/mobile/profiles/{userId}",
  tags: ["Mobile Profiles"],
  summary: "Update own profile",
  description:
    "Dating is 18+: for a profile under 18 (or with no age), a dating `intent_default` or a `looking_for` " +
    "containing \"dating\" (any case) is refused with 403 \"Dating is for 18+ only. Your other choices are fine.\", " +
    "and `orientations`, `interested_in` or `show_orientation: true` with 403 \"Orientation and who you're " +
    "interested in are for 18+ only.\" A new `age` or `dateOfBirth` under 18 is 400 (Blend'n is 18+, " +
    "SCRUM-330); clearing the age to unknown clears the stored dating intent, the \"dating\" in `looking_for`, " +
    "and the orientation fields. `onboarded: true` on a profile not yet onboarded is 403 \"Blend'n is for " +
    "people 18 and over. Add your date of birth to finish.\" unless the age after the request is 18+. " +
    "Changing `languages`, `home_state`, `sun_sign`/`sign_system` or `work_field` (a real change, once onboarded) " +
    "is limited to three a day — the fourth is 429 RATE_LIMITED \"You can change your languages, home state, sign " +
    "or field of work three times a day. Try again tomorrow.\" — and stamps `tier_b_changed_at`: in a room you " +
    "checked into before the change, your new values print no shared line.",
  security: bearerAuth,
  request: {
    params: z.object({ userId: z.string().uuid() }),
    body: { content: { "application/json": { schema: UpdateProfileRequestSchema } } },
  },
  responses: {
    200: { description: "Updated profile", content: { "application/json": { schema: wrap(ProfileResponseSchema) } } },
    ...standardErrors,
  },
})

// GET /api/mobile/profiles/{userId}/interests
registry.registerPath({
  method: "get",
  path: "/api/mobile/profiles/{userId}/interests",
  tags: ["Mobile Profiles"],
  summary: "Get user interests",
  description: ROOM_BAN_GATE +
    "A block, either way, answers **404** — the same as the profile itself (SCRUM-299). `userId` may be a room handle (SCRUM-371); through a handle for somebody that room keeps anonymous the list is empty — the room card shows shared interests only, and the whole list is the same in every room.",
  security: bearerAuth,
  request: { params: z.object({ userId: UserRefParamSchema }) },
  responses: {
    ...standardErrors,
    200: { description: "Interests", content: { "application/json": { schema: wrap(InterestsResponseSchema) } } },
    404: { description: "No such user, or a block between you" },
  },
})

// POST /api/mobile/profiles/{userId}/interests
registry.registerPath({
  method: "post",
  path: "/api/mobile/profiles/{userId}/interests",
  tags: ["Mobile Profiles"],
  summary: "Add interests",
  description:
    "Adds categories to your interests, at most 10 held (`TOO_MANY_INTERESTS`). Leaves only: a category with children is a group " +
    "heading and is refused with 400 and `reasonCode: CATEGORY_IS_A_GROUP`, storing nothing. A top-level category with no " +
    "children is its own option. An unknown id is 404.",
  security: bearerAuth,
  request: {
    params: z.object({ userId: z.string().uuid() }),
    body: { content: { "application/json": { schema: InterestCategoryIdsSchema } } },
  },
  responses: {
    200: { description: "Updated interests", content: { "application/json": { schema: wrap(InterestsResponseSchema) } } },
    ...standardErrors,
  },
})

// DELETE /api/mobile/profiles/{userId}/interests
registry.registerPath({
  method: "delete",
  path: "/api/mobile/profiles/{userId}/interests",
  tags: ["Mobile Profiles"],
  summary: "Remove interests",
  security: bearerAuth,
  request: {
    params: z.object({ userId: z.string().uuid() }),
    body: { content: { "application/json": { schema: InterestCategoryIdsSchema } } },
  },
  responses: {
    200: { description: "Updated interests", content: { "application/json": { schema: wrap(InterestsResponseSchema) } } },
    ...standardErrors,
  },
})

/*
 * GET /api/mobile/me/attendance
 *
 * `/me`, not `/users/{userId}/attendance`, and the shape is the point: a
 * person's attendance history is where they were on which nights, which is the
 * correlation the pseudonym design exists to prevent being assembled. Scoping
 * it to the caller by construction means there is no id to get wrong and no
 * future change that widens it by accident.
 */
registry.registerPath({
  method: "get",
  path: "/api/mobile/me/attendance",
  tags: ["Mobile Profiles"],
  summary: "The events the authenticated user has attended",
  description:
    "One entry per event, however many days of it they turned up for, most recently attended " +
    "first. `attendedAt` is the first check-in for that event. `pagination.totalCount` plus " +
    "`lockedCount` is the figure shown as `stats.eventsAttended` on a profile — they share one " +
    "predicate so the list and the number cannot disagree. Working an event as staff is not " +
    "attending it. Places you went live at are included, with `kind: venue_day`. Where Blendn+ is " +
    "gated (the city of your latest night) and you have none, the list is every night still running " +
    "plus your latest 3 ended nights (`end_time` before now), and `lockedCount` is how many ended nights " +
    "are older (Blendn+ unlocks them); a night still running is never locked and never one of the 3. A `venue_day` row also " +
    "carries `stay_minutes`, `venue_id` and `venue_type`; every row carries `ratedAt`. Yours alone, like everything here. " +
    "Page by `?page=` or by `?cursor=` (newest first, the event id breaking ties); `pagination.nextCursor` is on both.",
  security: bearerAuth,
  request: {
    query: PageOrCursorQuerySchema,
  },
  responses: {
    200: {
      description: "Attended events",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              events: z.array(
                z.object({
                  id: z.string().uuid(),
                  kind: z
                    .enum(["event", "venue_day"])
                    .describe(
                      "`venue_day` is a place you went live at (D-6): show `venue_name`, labelled as a place. Its `title` is bookkeeping, not for display."
                    ),
                  slug: z.string(),
                  title: z.string(),
                  cover_image_url: z.string().nullable(),
                  start_time: z.string().datetime(),
                  end_time: z.string().datetime(),
                  timezone: z.string().describe("The event's IANA zone (`events.timezone`, as `GET /events/{eventId}` sends it). Format `startTime`/`endTime` in it. Additive: absent from an older server."),
                  venue_name: z.string().nullable(),
                  city: z.string().nullable(),
                  attendedAt: z.string().datetime(),
                  stay_minutes: z
                    .number()
                    .int()
                    .min(0)
                    .nullable()
                    .describe(
                      "A `venue_day` visit's length: your presence sessions there, summed, in whole minutes. Null when unknown, and always null for an `event`."
                    ),
                  venue_id: z
                    .string()
                    .uuid()
                    .nullable()
                    .describe("A `venue_day` visit's venue, for its page. Always null for an `event`."),
                  venue_type: z
                    .string()
                    .nullable()
                    .describe("A `venue_day` visit's kind of place (`cafe`, `pub_bar`, ...), null when the venue has none. Always null for an `event`."),
                  ratedAt: z
                    .string()
                    .datetime()
                    .nullable()
                    .describe("When you last rated this night (`GET /events/{eventId}/rating`'s `ratedAt`): yours alone, null if you have not, and always null for a `venue_day`."),
                })
              ),
              pagination: PagedPaginationSchema,
              lockedCount: z.number().int().min(0).describe("Ended nights older than your latest 3 ended ones, behind Blendn+. 0 when nothing is locked."),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

/*
 * GET /api/mobile/me/rsvps
 *
 * `/me` for the same reason as attendance, in the future tense: where somebody
 * is going, and when, is the correlation the pseudonym design exists to keep
 * from being assembled.
 */
registry.registerPath({
  method: "get",
  path: "/api/mobile/me/rsvps",
  tags: ["Mobile Profiles"],
  summary: "The events the authenticated user is going to or waitlisted for",
  description:
    "RSVPs with status `going` or `waitlisted` for events that have not ended, soonest first. " +
    "Cancelled events are included with their status so the cancellation is seen; drafts and " +
    "deleted events are not. Event fields use the favourites route's names, plus `rsvpStatus` " +
    "and `rsvpAt` (when the RSVP was made). `visibility` is `public`, `unlisted` or `private`, so a card can say an event is unlisted. " +
    "`changedAt`/`changedFields` are `GET /events/:id`'s, so a row can say \"New time\". " +
    "Page by `?page=` or by `?cursor=` (soonest first, the RSVP id breaking ties); `pagination.nextCursor` is on both.",
  security: bearerAuth,
  request: {
    query: PageOrCursorQuerySchema,
  },
  responses: {
    200: {
      description: "Upcoming RSVPs",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              events: z.array(
                z.object({
                  id: z.string().uuid(),
                  slug: z.string(),
                  title: z.string(),
                  coverImageUrl: z.string().nullable(),
                  coverImage: z.record(z.string(), z.unknown()).nullable(),
                  startTime: z.string().datetime(),
                  endTime: z.string().datetime(),
                  session: EventSessionSchema,
                  timezone: z.string(),
                  status: z.enum(["published", "cancelled", "completed"]),
                  visibility: z.enum(["public", "unlisted", "private"]),
                  venueName: z.string().nullable(),
                  address: z.string().nullable(),
                  city: z.string().nullable(),
                  latitude: z.number().nullable(),
                  longitude: z.number().nullable(),
                  rsvpStatus: z.enum(["going", "waitlisted"]),
                  rsvpAt: z.string().datetime(),
                  changedAt: ChangedAtSchema,
                  changedFields: ChangedFieldsSchema,
                })
              ),
              pagination: PagedPaginationSchema,
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})
