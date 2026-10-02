import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors, UserRefParamSchema } from "@/lib/openapi/schemas/common"

/*
 * Crews (plan v2 §6; lib/crews). Friends who go out together: made from the
 * friend graph, 2–12 people, a crew chat (a room of kind `crew`), "We're here",
 * and crew cards at an event. Inside a crew people are named (first name and
 * photo); outside it a crew is an emblem, a name and counts — never a person.
 */

const bearerAuth = [{ bearerAuth: [] }]
const wrap = (schema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: schema })
const tags = ["Mobile Crews"]
const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } })

const CREW_404 =
  "A crew you are not in — or that does not exist, or has dissolved — is the same 404, so nothing here says which crews exist. "
const ADULTS =
  "403 \"Crews are for people 18 and over who have finished setting up.\" for an account under 18, with no age, or not finished onboarding. "
const TEXT_CHECKS =
  "The name (2–32 characters, not unique) and bio (≤140) are folded first — compatibility forms (fullwidth, ligatures), any script's " +
  "digits to 0–9, look-alike Cyrillic and Greek letters to Latin — and stored folded; a name with an invisible character in it " +
  "(zero-width, bidi override; an emoji's own joiner aside) is 400, a bio has them stripped. Then the moderation pipeline and a strict contact-detail " +
  "check — phone numbers, handles, emails and web addresses, written out or spelled (\"nine eight…\", \"at gmail dot com\"). " +
  "A refusal is 400 with a sentence saying which, and nothing is written. "

const Intent = z.enum(["dating", "networking", "friendship", "just_here"])
const Tag = z.object({ slug: z.string(), label: z.string() }).openapi("CrewTag")

const CrewMemberSchema = z
  .object({
    userId: z.string().describe("Yours is your own id; anyone else's is their handle in the crew's room"),
    name: z.string().describe("First name only"),
    photo: z.string().nullable(),
    role: z.enum(["owner", "member"]),
    joinedAt: z.string(),
  })
  .openapi("CrewMember")

const CrewSchema = z
  .object({
    crewId: z.string().uuid(),
    name: z.string(),
    bio: z.string().nullable(),
    intent: z.array(Intent),
    tags: z.array(Tag),
    emblemSeed: z.string().describe("Seeds the generated emblem"),
    openToSolo: z.boolean().describe("\"Room for one more tonight\""),
    createdAt: z.string(),
    chatGroupId: z.string().uuid().nullable().describe("The crew chat: `/chat/groups/{chatGroupId}/…`"),
    size: z.number().int(),
    you: z.object({ role: z.enum(["owner", "member"]), keepMeAnonymous: z.boolean() }).nullable(),
    members: z.array(CrewMemberSchema),
  })
  .openapi("Crew")

const CrewInviteSchema = z
  .object({
    crewId: z.string().uuid(),
    name: z.string(),
    bio: z.string().nullable(),
    emblemSeed: z.string(),
    tags: z.array(Tag),
    size: z.number().int(),
    invitedBy: z.string().describe("The friend who invited you, by first name"),
    invitedAt: z.string(),
  })
  .openapi("CrewInvite")

const CrewCardSchema = z
  .object({
    crewId: z.string().uuid(),
    name: z.string(),
    bio: z.string().nullable(),
    emblemSeed: z.string(),
    size: z.number().int().describe("\"Crew of N\": its active members"),
    presentCount: z.number().int().describe("\"Here now · N of size\" — always ≥ 2"),
    tags: z.array(Tag),
    intent: z.array(Intent),
    youLiked: z.boolean().describe("Whether your side liked this crew tonight. Never whether they liked you"),
  })
  .describe("Counts only: never a person's name, photo or pseudonym")
  .openapi("CrewCard")

const CrewFields = {
  name: z.string().min(2).max(32),
  bio: z.string().max(140).nullable().optional(),
  intent: z.array(Intent).optional(),
  tags: z.array(z.string()).max(3).optional().describe("Curated slugs only: quiz-team, run-club, techno-heads, office-gang, birthday-crew, foodies, board-gamers, gig-goers, book-club, dance-floor"),
  openToSolo: z.boolean().optional(),
}
const Consent = z
  .literal(true)
  .describe("Required. The app shows: \"Anyone in this crew can reveal the crew — your name and photos — to people you match with.\"")
const crewParams = z.object({ crewId: z.string().uuid() })

registry.registerPath({
  method: "get",
  path: "/api/mobile/crews",
  tags,
  summary: "My crews, and invites waiting for me",
  security: bearerAuth,
  responses: {
    200: { description: "Crews", ...json(wrap(z.object({ crews: z.array(CrewSchema), invites: z.array(CrewInviteSchema) }))) },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/crews",
  tags,
  summary: "Make a crew",
  description:
    ADULTS +
    TEXT_CHECKS +
    "You are its owner. `inviteUserIds` must all be your friends (a non-friend is the same 404 whoever they are, and nothing is written); " +
    "each gets a push that names nobody (one per inviter and invitee a day). `invited` is how many you asked for — a friend kept apart from you " +
    "(a block or a closed conversation) is left out without a word. The crew chat is made with the crew. " +
    "Caps: 409 when you already own 3 standing crews or are in 10; 429 after 3 new crews in 24 hours.",
  security: bearerAuth,
  request: {
    body: json(
      z.object({
        ...CrewFields,
        inviteUserIds: z.array(z.string()).max(11).optional(),
        revealConsent: Consent,
        keepMeAnonymous: z.boolean().optional().describe("\"Keep me anonymous even when my crew reveals\""),
      })
    ),
  },
  responses: {
    201: {
      description: "Made",
      ...json(wrap(z.object({ crewId: z.string().uuid(), chatGroupId: z.string().uuid(), invited: z.number().int() }))),
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/crews/{crewId}",
  tags,
  summary: "One of my crews",
  description: CREW_404,
  security: bearerAuth,
  request: { params: crewParams },
  responses: { 200: { description: "Crew", ...json(wrap(CrewSchema)) }, ...standardErrors },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/crews/{crewId}/report",
  tags,
  summary: "Report a crew's card",
  description:
    "Its name or bio. Reaches the admin queue with the name and bio as they read now; a moderator can hide the crew (no card, likes or " +
    "Blends; its members keep it) or dissolve it. Nobody in the crew is told. A second report from you while the first waits is the same " +
    "report (201 either way). 404 for a crew that is not there. Capped per minute and per day.",
  security: bearerAuth,
  request: {
    params: crewParams,
    body: json(
      z.object({
        reason: z.enum(["spam", "offensive", "contact_details", "impersonation", "other"]),
        description: z.string().max(500).optional(),
      })
    ),
  },
  responses: { 201: { description: "Reported", ...json(wrap(z.object({ reported: z.literal(true) }))) }, ...standardErrors },
})

registry.registerPath({
  method: "patch",
  path: "/api/mobile/crews/{crewId}",
  tags,
  summary: "Edit a crew (its owner)",
  description: CREW_404 + TEXT_CHECKS,
  security: bearerAuth,
  request: { params: crewParams, body: json(z.object({ ...CrewFields, name: CrewFields.name.optional() })) },
  responses: { 200: { description: "Crew", ...json(wrap(CrewSchema)) }, ...standardErrors },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/crews/{crewId}/invites",
  tags,
  summary: "Invite friends into a crew",
  description:
    CREW_404 +
    "Any member, their own friends only (the same 404 for anyone else, and nothing is written). Each friend is then invited, or skipped " +
    "without a word: already in, or invited and the invite still open; declined in the last 30 days; removed by the owner (only an owner's " +
    "invite brings them back); kept apart from anybody in the crew (a block or a closed conversation). `invited` is how many you asked for " +
    "either way, so it says nothing about anybody. An invite lapses after 14 days and can be sent again. One push per inviter and invitee a day. " +
    "409 when members plus open invites would pass 12.",
  security: bearerAuth,
  request: { params: crewParams, body: json(z.object({ userIds: z.array(z.string()).min(1).max(11) })) },
  responses: { 200: { description: "Invited", ...json(wrap(z.object({ invited: z.number().int() }))) }, ...standardErrors },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/crews/{crewId}/join",
  tags,
  summary: "Accept my invite",
  description:
    ADULTS +
    "404 without an open invite — and the same 404 when whoever invited you has left the crew or is no longer your friend, or you are kept " +
    "apart (a block or a closed conversation, either way) from anybody in it. 409 when the crew already has 12 — counted under a lock, so " +
    "two accepts at once cannot both take the last seat — or when you are already in 10 crews. " +
    "Joining is the reveal consent; `keepMeAnonymous` is the personal override.",
  security: bearerAuth,
  request: { params: crewParams, body: json(z.object({ revealConsent: Consent, keepMeAnonymous: z.boolean().optional() })) },
  responses: { 200: { description: "Joined", ...json(wrap(z.object({ chatGroupId: z.string().uuid() }))) }, ...standardErrors },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/crews/{crewId}/join",
  tags,
  summary: "Decline my invite",
  description: "Nobody is told. The invite stops showing, and for 30 days inviting you again neither re-invites nor re-notifies you.",
  security: bearerAuth,
  request: { params: crewParams },
  responses: { 200: { description: "Declined", ...json(wrap(z.object({ declined: z.literal(true) }))) }, ...standardErrors },
})

registry.registerPath({
  method: "patch",
  path: "/api/mobile/crews/{crewId}/members/{userId}",
  tags,
  summary: "My settings in a crew",
  description:
    "`userId` is your own id. \"Keep me anonymous even when my crew reveals\" — from now on: a crew reveal already made is not undone (D-10).",
  security: bearerAuth,
  request: {
    params: z.object({ crewId: z.string().uuid(), userId: UserRefParamSchema }),
    body: json(z.object({ keepMeAnonymous: z.boolean() })),
  },
  responses: { 200: { description: "Saved", ...json(wrap(z.object({ keepMeAnonymous: z.boolean() }))) }, ...standardErrors },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/crews/{crewId}/members/{userId}",
  tags,
  summary: "Leave a crew, or remove a member (its owner)",
  description:
    CREW_404 +
    "Your own id leaves. The owner removes somebody by their handle in the crew's room (from `GET /crews/{crewId}`); a raw id or " +
    "another room's handle names nobody. A removal sticks: only an owner's invite brings them back. An owner who leaves hands the crew " +
    "to the active member who has been in it longest. A crew left with fewer than two active members (suspended and erased people do " +
    "not count) dissolves (`dissolved: true`): its chat archives and closes.",
  security: bearerAuth,
  request: { params: z.object({ crewId: z.string().uuid(), userId: UserRefParamSchema }) },
  responses: { 200: { description: "Out", ...json(wrap(z.object({ dissolved: z.boolean() }))) }, ...standardErrors },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/crews/{crewId}/here",
  tags,
  summary: "\"We're here\"",
  description:
    CREW_404 +
    "You must be checked in at the event now (403 otherwise); nobody else is checked in by this — each member checks in by their own GPS. " +
    "Writes a line in the crew chat (type `system`, metadata `{ kind: \"crew_here\", eventId, occurrenceId }`) and pushes every other " +
    "member who has not muted the crew chat or blocked you — once per person per crew per occurrence (`repeated: true` after that; the " +
    "line itself is the record, so it holds across restarts). Somebody who turned notifications off gets the bell line, not a push. " +
    "The push names nobody and no place. 403 when the host turned crews off.",
  security: bearerAuth,
  request: { params: crewParams, body: json(z.object({ eventId: z.string().uuid() })) },
  responses: {
    200: { description: "Told", ...json(wrap(z.object({ notified: z.number().int(), repeated: z.boolean() }))) },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/crews",
  tags,
  summary: "Crews here now",
  description:
    "For somebody checked in here now (403 `NOT_CHECKED_IN` otherwise). A crew is here when two or more of its active members are checked in " +
    "at this occurrence — derived, never stored. Never your own crews (those are `myCrews`), never a hidden crew, never a crew with any member " +
    "kept apart (a block or a closed conversation, either way) from you or any member of your crews here. Without a crew of your own here " +
    "you see crews only after opting in (\"Open to joining a crew tonight\", for the night you said it), and only crews with room for one more " +
    "no bigger than 6, and not out for dating unless you are too. Cards carry counts, never people. Most here first, a page at a time. `crewsEnabled: false` when the host turned crews off.",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    query: z.object({
      limit: z.number().int().min(1).max(50).optional().describe("Default 30"),
      offset: z.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "Crews",
      ...json(
        wrap(
          z.object({
            crewsEnabled: z.boolean(),
            crews: z.array(CrewCardSchema),
            myCrews: z.array(z.object({ crewId: z.string().uuid(), name: z.string(), presentCount: z.number().int() })),
            total: z.number().int().describe("Every crew you may see here now, across pages"),
            hasMore: z.boolean(),
          })
        )
      ),
    },
    ...standardErrors,
  },
})

const BlendRef = z.object({ blendId: z.string().uuid(), chatGroupId: z.string().uuid() })

registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/crews/{crewId}/like",
  tags,
  summary: "Like a crew here now",
  description:
    "You must be checked in here now (403). With `asCrewId` (one of your crews here — two of you checked in, 403 otherwise) it is crew → crew, " +
    "on your crew's behalf: no vote, and your crew chat says \"liked <crew> for the crew\". Without it, it is you → crew: you must have opted in " +
    "to crews for this event (403), and the crew must have room for one more, be 6 or fewer, and not be out for dating unless you are. " +
    "A crew not here, a block between any member of one side and any of the other, two crews sharing a member, or a guardrail about the " +
    "other side is the same 404. If they liked you back, `blend` is the one Blend room it made — two likes at the same instant still make one. " +
    "Liking twice is liking once. Nothing anywhere says who liked first.",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid(), crewId: z.string().uuid() }),
    body: json(z.object({ asCrewId: z.string().uuid().optional() })),
  },
  responses: {
    200: { description: "Liked", ...json(wrap(z.object({ liked: z.literal(true), blend: BlendRef.nullable() }))) },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/crews/{crewId}/reveal",
  tags,
  summary: "Reveal my crew at an event",
  description:
    CREW_404 +
    "One tap reveals the crew where it was done (owner decision (a)): every member at this event who has not switched on " +
    "\"keep me anonymous\" — consent was taken when they joined — is written as their own per-event reveal, so the event's room and its " +
    "Blends name them exactly as if each had revealed. Members keeping themselves anonymous stay pseudonyms. You must be in the event's " +
    "room (403). Nothing is ever un-revealed by it (D-10).",
  security: bearerAuth,
  request: { params: crewParams, body: json(z.object({ eventId: z.string().uuid() })) },
  responses: {
    200: {
      description: "Revealed",
      ...json(wrap(z.object({ revealed: z.number().int(), keptPrivate: z.number().int() }))),
    },
    ...standardErrors,
  },
})

const BlendPersonSchema = z
  .object({
    userId: z.string().describe("Yours is your own id; anyone else's is their handle in the Blend's room"),
    pseudonym: z.string().describe("Tonight's pseudonym"),
    name: z.string().nullable().describe("First name, only where the event's room would name them (a reveal)"),
    photo: z.string().nullable(),
  })
  .openapi("BlendPerson")

registry.registerPath({
  method: "get",
  path: "/api/mobile/blends",
  tags,
  summary: "My open Blends",
  description:
    "Each Blend I am let into now: its room (`chatGroupId`, a room of kind `blend`), when it closes (the occurrence's end + 12 h), and its two " +
    "sides — the people here on each by tonight's pseudonym, named only where the event's room would name them, with \"N revealed · M keep " +
    "it private\" per crew. A Blend closes early when somebody on one side blocks somebody on the other. Anyone may leave it on their own " +
    "(`POST /chat/groups/{chatGroupId}/leave`).",
  security: bearerAuth,
  responses: {
    200: {
      description: "Blends",
      ...json(
        wrap(
          z.object({
            blends: z.array(
              z.object({
                blendId: z.string().uuid(),
                chatGroupId: z.string().uuid(),
                eventId: z.string().uuid(),
                closesAt: z.string(),
                sides: z.array(
                  z.object({
                    kind: z.enum(["crew", "person"]),
                    crewId: z.string().uuid().nullable(),
                    name: z.string().nullable(),
                    emblemSeed: z.string().nullable(),
                    revealed: z.number().int(),
                    keptPrivate: z.number().int(),
                    people: z.array(BlendPersonSchema),
                  })
                ),
              })
            ),
          })
        )
      ),
    },
    ...standardErrors,
  },
})
