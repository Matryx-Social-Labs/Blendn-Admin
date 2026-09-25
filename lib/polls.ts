import { Refusal } from "./refusal"
import { bannedRefusal, chatWindowState, roomReadDenial } from "@/lib/chat-window"
import { db } from "@/lib/db"
import { discloseBreakdown, suppressedLabel, type Disclosed } from "@/lib/disclosure"

/*
 * Reading and voting on a poll — for the mobile routes, which pass the person
 * they authenticated.
 *
 * Not in `poll-actions.ts`, which is a "use server" module: every export there
 * is an action a page can dispatch by id, and both of these take the reader's
 * or voter's id as an argument. Registered as actions, any dashboard session
 * could read any room's poll or vote as anybody (security review of SCRUM-298).
 * A plain module cannot become one.
 */

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
export async function getPollResults(
  pollId: string,
  reader: { userId: string; eventId: string }
): Promise<PollResults> {
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
      message: {
        select: {
          deleted_at: true,
          chat_group: {
            select: {
              event_id: true,
              event: { select: { status: true, deleted_at: true } },
              members: { where: { user_id: reader.userId }, select: { status: true, banned_by: true } },
            },
          },
        },
      },
    },
  })

  /*
   * A poll is a message in the room, so it is read by the room's rule
   * (SCRUM-298). This loaded the poll by id alone: anybody with a token read
   * the question and options of a room they were never in, a member the
   * organiser had banned kept reading, and the event in the URL was ignored.
   * The same read rule as the room's history, roster and socket (SCRUM-205);
   * a poll outside the event named in the URL does not exist there.
   */
  const room = poll?.message.chat_group
  if (!poll || poll.message.deleted_at || room?.event_id !== reader.eventId) {
    throw new Refusal("Poll not found")
  }
  const membership = room.members[0]
  const denial = roomReadDenial(membership, room.event)
  if (denial === "hidden") throw new Refusal("Poll not found")
  if (denial === "not_member") throw new Refusal("You are not in this chatroom")
  if (denial === "banned") throw new Refusal(bannedRefusal(membership))

  const closed = poll.closes_at !== null && poll.closes_at <= new Date()

  const grouped = await db.chat_poll_votes.groupBy({
    by: ["option_id"],
    where: { poll_id: pollId },
    _count: { _all: true },
  })
  const countFor = new Map(grouped.map((g) => [g.option_id, g._count._all]))

  const myVote =
    (
      await db.chat_poll_votes.findUnique({
        where: { poll_id_user_id: { poll_id: pollId, user_id: reader.userId } },
        select: { option_id: true },
      })
    )?.option_id ?? null

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
  userId: string,
  eventId: string
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
              event_id: true,
              status: true,
              event: { select: { start_time: true, end_time: true, status: true } },
            },
          },
        },
      },
    },
  })
  // The event in the URL, as the read checks it: a vote does not travel
  // through another event's address (SCRUM-298).
  if (!poll || poll.message.deleted_at || poll.message.chat_group.event_id !== eventId) {
    throw new Refusal("Poll not found")
  }

  // Scoped to this poll, so an option id from another poll cannot be smuggled
  // in — the composite foreign key would reject it, but a clear refusal beats a
  // constraint violation surfacing as a 500.
  if (poll.options.length === 0) throw new Refusal("That is not an option on this poll")

  if (poll.closes_at && poll.closes_at <= new Date()) {
    throw new Refusal("This poll has closed")
  }

  const window = chatWindowState(poll.message.chat_group.event, poll.message.chat_group)
  if (!window.open) throw new Refusal("The chatroom is not open")

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
  if (!member) throw new Refusal("You are not in this chatroom")

  await db.chat_poll_votes.upsert({
    where: { poll_id_user_id: { poll_id: pollId, user_id: userId } },
    update: { option_id: optionId },
    create: { poll_id: pollId, option_id: optionId, user_id: userId },
  })
}
