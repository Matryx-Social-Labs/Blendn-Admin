/**
 * Everything waiting on a human, counted once.
 *
 * ## Why this is a module and not two queries
 *
 * The nav badges and the overview's attention strip answered the same question
 * from different code, and they disagreed on screen: the sidebar showed
 * `Claims 4` and `Applications 7` while the strip directly beside it read
 * *"Moderation queue is clear."* Eleven things were waiting and the one panel
 * whose entire job is "is anything waiting" said no.
 *
 * It said no honestly — it only ever counted `moderation_flags`. That is the
 * shape of the bug: not a wrong number, a **partial** one, rendered with the
 * confidence of a complete one. Widening the strip's own query would have
 * fixed today's screen and left the two counts free to drift again the next
 * time a queue is added, which is how this happened in the first place.
 *
 * So there is one list. `app/dashboard/layout.tsx` derives its badges from it
 * and `buildAdminOverview` renders it, and a fifth queue added here appears in
 * both without either being edited.
 *
 * ## One row per destination, not per table
 *
 * A row is somewhere you can go and decide, which is why moderation is one row
 * over three tables and claims is one row over three more. The nav already
 * makes exactly this choice — one `Moderation` entry, one `Claims` entry —
 * and a strip that split them would be offering routes the nav does not have.
 * `__tests__/attention-queues.test.ts` holds the two in step.
 *
 * ## Why the query lives next door
 *
 * `components/dashboard/attention-strip.tsx` is a client component and needs
 * `byUrgency` and `queueAgeLabel` at runtime. This file therefore may not
 * import `db` — `lib/db.ts` pulls in `pg`, and a real `next build` refuses to
 * bundle it for the browser. `tsc` and the whole unit suite are blind to that,
 * because Jest resolves the import happily and never asks which bundle it
 * lands in; the build is the only thing that notices. Hence
 * `lib/attention-queues-query.ts`.
 */
export type QueueKey = "moderation" | "claims" | "applications" | "creative"

export interface AttentionQueue {
  key: QueueKey
  /** Reads after a count: "4 claims", "1 flag or report". */
  label: string
  labelPlural: string
  count: number
  /** ISO, or null when the queue is empty. Serialised — this crosses to a client component. */
  oldest: string | null
  href: string
  /**
   * How long an item in this queue may wait before the age turns red.
   *
   * Per queue rather than one global number, because these are not the same
   * kind of waiting. A flagged message sitting for a day means somebody is
   * reading something that should have been pulled; an application sitting for
   * a day means an organiser is mildly impatient. One SLA across both would be
   * either too loud for applications or too quiet for moderation, and too
   * quiet is the failure that matters.
   */
  slaHours: number
}

export const SHAPE: Record<QueueKey, Omit<AttentionQueue, "count" | "oldest">> = {
  moderation: {
    key: "moderation",
    label: "flag or report",
    labelPlural: "flags and reports",
    href: "/dashboard/moderation",
    slaHours: 24,
  },
  claims: {
    key: "claims",
    label: "claim",
    labelPlural: "claims",
    href: "/dashboard/claims",
    slaHours: 72,
  },
  applications: {
    key: "applications",
    label: "organiser application",
    labelPlural: "organiser applications",
    href: "/dashboard/onboarding",
    slaHours: 72,
  },
  creative: {
    key: "creative",
    label: "sponsored creative",
    labelPlural: "sponsored creatives",
    // Blocks a paying sponsor's campaign from running at all, and unlike every
    // other queue here the content has NOT yet reached anybody — so the cost of
    // being slow is commercial rather than safety, and the bar sits between the
    // two.
    href: "/dashboard/creative-review",
    slaHours: 48,
  },
}



/** The nav badge map, derived rather than counted a second time. */
export function queueBadges(queues: AttentionQueue[]): Record<string, number> {
  return {
    pendingFlags: queues.find((q) => q.key === "moderation")?.count ?? 0,
    pendingClaims: queues.find((q) => q.key === "claims")?.count ?? 0,
    pendingApplications: queues.find((q) => q.key === "applications")?.count ?? 0,
    pendingCreative: queues.find((q) => q.key === "creative")?.count ?? 0,
  }
}

/** How many people are waiting on a decision, across every queue. */
export function totalWaiting(queues: AttentionQueue[]): number {
  return queues.reduce((sum, q) => sum + q.count, 0)
}

/**
 * Age of the oldest item, in the words the strip uses.
 *
 * `open` for one and `oldest` for several, because "oldest 29 days" over a
 * single report reads as though there are others behind it. Hours below a day:
 * a queue that turned over this morning should not read "0 days".
 */
export function queueAgeLabel(
  queue: Pick<AttentionQueue, "count" | "oldest">,
  now: Date
): string | null {
  if (queue.count === 0 || !queue.oldest) return null
  const hours = Math.floor((now.getTime() - new Date(queue.oldest).getTime()) / 3_600_000)
  const lead = queue.count === 1 ? "open" : "oldest"
  if (hours < 1) return `${lead} under an hour`
  if (hours < 24) return `${lead} ${hours}h`
  const days = Math.floor(hours / 24)
  return `${lead} ${days} day${days === 1 ? "" : "s"}`
}

/** Past this queue's own SLA — the thing that turns the age red. */
export function queueBreached(
  queue: Pick<AttentionQueue, "count" | "oldest" | "slaHours">,
  now: Date
): boolean {
  if (queue.count === 0 || !queue.oldest) return false
  return now.getTime() - new Date(queue.oldest).getTime() > queue.slaHours * 3_600_000
}

/**
 * Queues first, oldest breach first, then by count.
 *
 * A cleared queue sorts last but is never dropped — see `attentionQueues`.
 */
export function byUrgency(queues: AttentionQueue[], now: Date): AttentionQueue[] {
  return [...queues].sort((a, b) => {
    if ((a.count === 0) !== (b.count === 0)) return a.count === 0 ? 1 : -1
    const aBreach = queueBreached(a, now)
    const bBreach = queueBreached(b, now)
    if (aBreach !== bBreach) return aBreach ? -1 : 1
    const aAge = a.oldest ? new Date(a.oldest).getTime() : Infinity
    const bAge = b.oldest ? new Date(b.oldest).getTime() : Infinity
    if (aAge !== bAge) return aAge - bAge
    return b.count - a.count
  })
}
