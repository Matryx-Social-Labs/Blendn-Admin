"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { chatWindowState } from "@/lib/chat-window"
import { db } from "@/lib/db"
import { discloseBreakdown, suppressedLabel, type Disclosed } from "@/lib/disclosure"
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
  if (!session?.user) throw new Error("Unauthorized")

  const parsed = pollSchema.safeParse(input)
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid poll")
  const { question, options, closesAt, resultsVisible, kind } = parsed.data

  // Two options with the same label make a result nobody can act on, and the
  // position unique would not catch it.
  const labels = options.map((o) => o.toLowerCase())
  if (new Set(labels).size !== labels.length) {
    throw new Error("Two options say the same thing")
  }

  const event = await db.events.findUnique({
    where: { id: eventId, deleted_at: null },
    select: {
      id: true,
      start_time: true,
      end_time: true,
      chat_group: { select: { id: true, status: true } },
      ...eventPermissionSelect,
    },
  })
  if (!event) throw new Error("Event not found")

  const actor = await actorFor(session.user)

  /*
   * The same gate as any other non-user message. A poll from a brand is a
   * sponsored broadcast — it carries the brand's name into the room and occupies
   * the same attention — so it needs the same grant, not a weaker one because
   * the payload happens to be a question.
   */
  const grant = kind === "sponsored" ? await resolveSponsorGrant(actor, eventId) : undefined
  if (!canBroadcast(actor, event, kind as BroadcastKind, grant ?? undefined)) {
    throw new Error("Forbidden")
  }

  if (!event.chat_group) throw new Error("This event has no chatroom yet.")

  const window = chatWindowState(event, event.chat_group)
  if (!window.open) throw new Error("The chatroom is not open.")

  /*
   * Defaults to the END OF THE EVENT, not the end of the room.
   *
   * The room opens before doors and stays open for a feedback window after, so
   * "closes with the room" would leave a poll posted during setup running for
   * days and collecting votes from people who have gone home.
   */
  const closes = closesAt ?? event.end_time
  if (closes <= new Date()) throw new Error("That closing time has already passed.")
  if (closes > event.end_time) {
    throw new Error("A poll cannot outlast the event it is in.")
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

export interface PollOptionResult {
  id: string
  label: string
  position: number
  /** `null` means "withheld", never "zero". */
  votes: Disclosed<number>
}

export interface PollResults {
  id: string
  question: string
  closesAt: Date | null
  closed: boolean
  resultsVisible: boolean
  options: PollOptionResult[]
  total: Disclosed<number>
  suppressed: boolean
  /** What to render in place of the numbers. Null when nothing is withheld. */
  suppressedLabel: string | null
  /** Which option this reader chose, if any. */
  myVote: string | null
}

/**
 * One poll, disclosed.
 *
 * The counts are computed here and reduced before they are returned. A caller
 * cannot ask for raw numbers, which is the point — the previous shape of this
 * bug across the codebase was a helper that returned the truth and trusted every
 * caller to blur it.
 */
export async function getPollResults(pollId: string, viewerId?: string): Promise<PollResults> {
  const poll = await db.chat_polls.findUnique({
    where: { id: pollId },
    select: {
      id: true,
      question: true,
      closes_at: true,
      results_visible: true,
      options: {
        select: { id: true, label: true, position: true },
        orderBy: { position: "asc" },
      },
    },
  })
  if (!poll) throw new Error("Poll not found")

  const closed = poll.closes_at !== null && poll.closes_at <= new Date()

  const grouped = await db.chat_poll_votes.groupBy({
    by: ["option_id"],
    where: { poll_id: pollId },
    _count: { _all: true },
  })
  const countFor = new Map(grouped.map((g) => [g.option_id, g._count._all]))

  const myVote = viewerId
    ? (
        await db.chat_poll_votes.findUnique({
          where: { poll_id_user_id: { poll_id: pollId, user_id: viewerId } },
          select: { option_id: true },
        })
      )?.option_id ?? null
    : null

  /*
   * Nothing at all while it is open, unless the poll opted in.
   *
   * Not "counts of zero" and not the real numbers blurred — the absence is the
   * protection. A running total biases later voters, and in a small room the
   * first vote landing is visible to everyone watching.
   */
  const reveal = closed || poll.results_visible

  const counts = poll.options.map((o) => countFor.get(o.id) ?? 0)
  const disclosed = reveal
    ? discloseBreakdown(counts)
    : { cells: counts.map(() => null), total: null, suppressed: true }

  return {
    id: poll.id,
    question: poll.question,
    closesAt: poll.closes_at,
    closed,
    resultsVisible: poll.results_visible,
    options: poll.options.map((o, i) => ({
      id: o.id,
      label: o.label,
      position: o.position,
      votes: disclosed.cells[i],
    })),
    total: disclosed.total,
    suppressed: disclosed.suppressed,
    suppressedLabel: disclosed.suppressed
      ? reveal
        ? suppressedLabel("poll")
        : "Results appear when the poll closes"
      : null,
    myVote,
  }
}

/**
 * Cast or change a vote.
 *
 * An upsert on `(poll_id, user_id)`, which is the unique that makes one vote per
 * person a database fact rather than an application convention. Changing a vote
 * is allowed while the poll is open: the alternative is a misclick that cannot
 * be corrected, and the count is recomputed on read either way.
 *
 * Exported for the mobile route; the dashboard does not vote.
 */
export async function castVote(
  pollId: string,
  optionId: string,
  userId: string
): Promise<void> {
  const poll = await db.chat_polls.findUnique({
    where: { id: pollId },
    select: {
      id: true,
      closes_at: true,
      options: { where: { id: optionId }, select: { id: true } },
      message: {
        select: {
          chat_group_id: true,
          deleted_at: true,
          chat_group: {
            select: {
              id: true,
              status: true,
              event: { select: { start_time: true, end_time: true } },
            },
          },
        },
      },
    },
  })
  if (!poll || poll.message.deleted_at) throw new Error("Poll not found")

  // Scoped to this poll, so an option id from another poll cannot be smuggled
  // in — the composite foreign key would reject it, but a clear refusal beats a
  // constraint violation surfacing as a 500.
  if (poll.options.length === 0) throw new Error("That is not an option on this poll")

  if (poll.closes_at && poll.closes_at <= new Date()) {
    throw new Error("This poll has closed")
  }

  const window = chatWindowState(poll.message.chat_group.event, poll.message.chat_group)
  if (!window.open) throw new Error("The chatroom is not open")

  /*
   * Only people in the room.
   *
   * `active` and `muted`: a muted member still reads the room and a poll is not
   * speech. Someone who has left is not a participant, and their row is kept
   * only because the pseudonym lives on it.
   */
  const member = await db.chat_group_members.findFirst({
    where: {
      chat_group_id: poll.message.chat_group_id,
      user_id: userId,
      status: { in: ["active", "muted"] },
    },
    select: { id: true },
  })
  if (!member) throw new Error("You are not in this chatroom")

  await db.chat_poll_votes.upsert({
    where: { poll_id_user_id: { poll_id: pollId, user_id: userId } },
    update: { option_id: optionId },
    create: { poll_id: pollId, option_id: optionId, user_id: userId },
  })
}
