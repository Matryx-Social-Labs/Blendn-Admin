import { db } from "@/lib/db"

/**
 * Who came, and who came back.
 *
 * `occurrence_id` on `event_check_ins` made this askable for the first time —
 * before it, a five-day conference held one row per attendee and "who came on
 * Wednesday" had no answer at all.
 *
 * **Staff are excluded from every number here.** They attend every day by
 * definition and would swamp "returning", turning the most useful figure on the
 * screen into a headcount of the crew. Occupancy counts them, because fire
 * safety counts bodies; this does not, because they are not attendees.
 */

export interface DayAttendance {
  occursOn: string
  /** Distinct guests who checked in that day. */
  unique: number
  /** First day of this event they have appeared on. */
  newcomers: number
  /** Attended an earlier day of the same event. */
  returning: number
  cancelled: boolean
}

export interface EventAttendance {
  /** Distinct guests across the whole run. */
  uniqueTotal: number
  /** Guests who said they were coming. */
  going: number
  /** Of those, how many actually turned up. Null when nobody RSVP'd. */
  turnUpPct: number | null
  days: DayAttendance[]
  /** True for the ordinary single-evening event, which is most of them. */
  singleDay: boolean
  /**
   * Of day one's guests, the share who came back on the last day.
   * Null unless there are at least two days that ran.
   */
  retentionPct: number | null
}

/**
 * One query, then arithmetic in memory.
 *
 * The alternative is a LATERAL join computing "has this person appeared on an
 * earlier day" per row, which is correct but opaque. At the scale of one
 * event's attendees, pulling the pairs and doing set arithmetic is both faster
 * to read and easier to test.
 */
export async function getEventAttendance(eventId: string): Promise<EventAttendance> {
  const [occurrences, checkIns, going] = await Promise.all([
    db.event_occurrences.findMany({
      where: { event_id: eventId },
      orderBy: { occurs_on: "asc" },
      select: { id: true, occurs_on: true, cancelled_at: true },
    }),
    db.event_check_ins.findMany({
      where: { event_id: eventId, kind: "attendee", check_in_time: { not: null } },
      select: { user_id: true, occurrence: { select: { occurs_on: true } } },
    }),
    db.event_rsvps.count({ where: { event_id: eventId, status: "going" } }),
  ])

  const byDay = new Map<string, Set<string>>()
  for (const ci of checkIns) {
    const key = ci.occurrence.occurs_on.toISOString().slice(0, 10)
    if (!byDay.has(key)) byDay.set(key, new Set())
    byDay.get(key)!.add(ci.user_id)
  }

  // A day that did not run is not a day nobody came to, so it is excluded from
  // every denominator below.
  const ran = occurrences.filter((o) => o.cancelled_at === null)

  const seen = new Set<string>()
  const days: DayAttendance[] = occurrences.map((o) => {
    const key = o.occurs_on.toISOString().slice(0, 10)
    const attendees = byDay.get(key) ?? new Set<string>()

    let newcomers = 0
    for (const userId of attendees) {
      if (!seen.has(userId)) newcomers++
    }
    // Only after counting, so "new" means new as of this day.
    if (o.cancelled_at === null) for (const userId of attendees) seen.add(userId)

    return {
      occursOn: key,
      unique: attendees.size,
      newcomers,
      returning: attendees.size - newcomers,
      cancelled: o.cancelled_at !== null,
    }
  })

  const uniqueTotal = new Set(checkIns.map((c) => c.user_id)).size

  let retentionPct: number | null = null
  if (ran.length >= 2) {
    const firstKey = ran[0].occurs_on.toISOString().slice(0, 10)
    const lastKey = ran[ran.length - 1].occurs_on.toISOString().slice(0, 10)
    const firstDay = byDay.get(firstKey) ?? new Set<string>()
    const lastDay = byDay.get(lastKey) ?? new Set<string>()
    if (firstDay.size > 0) {
      let stayed = 0
      for (const userId of firstDay) if (lastDay.has(userId)) stayed++
      retentionPct = Math.round((stayed / firstDay.size) * 100)
    }
  }

  return {
    uniqueTotal,
    going,
    // Against people who said they were coming, not against capacity: an event
    // that half filled and had everyone turn up did the hard part right.
    turnUpPct: going === 0 ? null : Math.round((Math.min(uniqueTotal, going) / going) * 100),
    days,
    singleDay: ran.length <= 1,
    retentionPct,
  }
}
