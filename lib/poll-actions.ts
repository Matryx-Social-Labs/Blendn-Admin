"use server"

import { Refusal } from "./refusal"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { chatWindowState } from "@/lib/chat-window"
import { db } from "@/lib/db"
import { actorFor, resolveSponsorGrant } from "@/lib/org-membership"
import { canBroadcast, eventPermissionSelect, type BroadcastKind } from "@/lib/rbac"

/**
 * Polls in an event room.
 *
 * A poll is a `chat_messages` row of type `poll` with a `chat_polls` row hanging
 * off it, so it lives in the transcript like everything else — it scrolls, it
 * can be moderated, it is deleted with the room. The alternative, a parallel
 * feed, would need its own ordering, its own moderation and its own retention.
 *
 * ## Why the results are not a count
 *
 * Every number that leaves this module goes through `lib/disclosure.ts`. In a
 * room of six, "1 vote · Leaving early" names that person to everyone still in
 * it, and `DESIGN_HANDOFF.md` guarantees small rooms are normal — check-in never
 * refuses, so capacity is a signal and not a door.
 *
 * Suppressing the small cell alone is not enough, which is the whole reason that
 * module exists: publishing the total lets you subtract, and hiding all but one
 * cell leaves the survivor recoverable. Raw counts never leave this file.
 *
 * ## Why results are hidden until close by default
 *
 * `chat_polls.results_visible` defaults to false because a running total biases
 * later voters. It is also a timing oracle: in a room of four, everyone watching
 * sees `0 → 1` the instant somebody votes, which is the same leak shape as the
 * typing indicator. So counts are computed on read and refused before close
 * unless the poll opted in — there is no per-vote emission to leak from.
 */

const pollSchema = z.object({
  question: z.string().trim().min(3, "Ask a question").max(200),
  options: z
    .array(z.string().trim().min(1).max(80))
    .min(2, "A poll needs at least two options")
    .max(6, "Six options is the most a phone can read at a glance"),
  /** Null means "closes when the event ends", which is the default. */
  closesAt: z.date().nullable().optional(),
  resultsVisible: z.boolean().default(false),
  kind: z.enum(["announcement", "sponsored"]).default("announcement"),
})

export interface CreatePollResult {
  messageId: string
  pollId: string
}

export async function createPoll(eventId: string, input: unknown): Promise<CreatePollResult> {
  const session = await getAuth()
  if (!session?.user) throw new Refusal("Unauthorized")

  const parsed = pollSchema.safeParse(input)
  if (!parsed.success) throw new Refusal(parsed.error.issues[0]?.message ?? "Invalid poll")
  const { question, options, closesAt, resultsVisible, kind } = parsed.data

  // Two options with the same label make a result nobody can act on, and the
  // position unique would not catch it.
  const labels = options.map((o) => o.toLowerCase())
  if (new Set(labels).size !== labels.length) {
    throw new Refusal("Two options say the same thing")
  }

  const event = await db.events.findUnique({
    where: { id: eventId, deleted_at: null },
    select: {
      id: true,
      start_time: true,
      end_time: true,
      status: true,
      chat_group: { select: { id: true, status: true } },
      ...eventPermissionSelect,
    },
  })
  if (!event) throw new Refusal("Event not found")

  const actor = await actorFor(session.user)

  /*
   * The same gate as any other non-user message. A poll from a brand is a
   * sponsored broadcast — it carries the brand's name into the room and occupies
   * the same attention — so it needs the same grant, not a weaker one because
   * the payload happens to be a question.
   */
  const grant = kind === "sponsored" ? await resolveSponsorGrant(actor, eventId) : undefined
  if (!canBroadcast(actor, event, kind as BroadcastKind, grant ?? undefined)) {
    throw new Refusal("Forbidden")
  }

  if (!event.chat_group) throw new Refusal("This event has no chatroom yet.")

  const window = chatWindowState(event, event.chat_group)
  if (!window.open) throw new Refusal("The chatroom is not open.")

  /*
   * Defaults to the END OF THE EVENT, not the end of the room.
   *
   * The room opens before doors and stays open for a feedback window after, so
   * "closes with the room" would leave a poll posted during setup running for
   * days and collecting votes from people who have gone home.
   */
  const closes = closesAt ?? event.end_time
  if (closes <= new Date()) throw new Refusal("That closing time has already passed.")
  if (closes > event.end_time) {
    throw new Refusal("A poll cannot outlast the event it is in.")
  }

  const created = await db.$transaction(async (tx) => {
    const message = await tx.chat_messages.create({
      data: {
        chat_group_id: event.chat_group!.id,
        user_id: session.user.id,
        type: "poll",
        // The question doubles as the message body so every existing reader —
        // the transcript, search, the moderation queue, a client that does not
        // know the `poll` type yet — shows something meaningful.
        content: question,
        metadata: { poll: true, kind },
      },
      select: { id: true, created_at: true },
    })

    const poll = await tx.chat_polls.create({
      data: {
        message_id: message.id,
        question,
        closes_at: closes,
        results_visible: resultsVisible,
        options: {
          create: options.map((label, position) => ({ label, position })),
        },
      },
      select: { id: true },
    })

    await tx.chat_groups.update({
      where: { id: event.chat_group!.id },
      data: { last_message_at: message.created_at },
    })

    return { messageId: message.id, pollId: poll.id }
  })

  auditLog({
    userId: session.user.id,
    action: kind === "sponsored" ? "poll.create_sponsored" : "poll.create",
    resource: "chat_polls",
    resourceId: created.pollId,
    details: { eventId, question, options: options.length, closesAt: closes.toISOString() },
  })

  revalidatePath(`/dashboard/events/${eventId}/messaging`)
  return created
}
