/**
 * What a refused check-in says, when the distance stops being walkable.
 *
 * The sentence was built for the near case and only the near case:
 *
 *     `You're about ${Math.round(verdict.shortfall)}m outside the check-in area.
 *      Move closer to the venue and try again.`
 *
 * At 45m that is exactly right — a number you can act on and an action that
 * works. Driven from Saarbrücken against a Bengaluru event, it produced:
 *
 *     You're about 7514501m outside the check-in area. Move closer to the venue
 *     and try again.
 *
 * Seven digits of metres, and advice that is wrong: nobody walks 7,514km closer.
 * The far case is not rare either — it is the wrong city, a lost fix, or an
 * event bookmarked from home, which is most of the ways this refusal is ever
 * seen.
 *
 * Two bands, because there are two situations and they want different sentences,
 * not one sentence stretched across both. The client renders this verbatim and
 * deliberately — `lib/checkInRefusal.ts` there says "the number belongs to the
 * server" — so the phrasing has to be right here or it is wrong on the phone.
 */

/**
 * Below this, the metre count is actionable and "move closer" is true advice.
 * A kilometre is roughly a twelve-minute walk; past that the number stops being
 * something you close on foot.
 */
export const WALKABLE_SHORTFALL_METRES = 1000

export function outOfRangeMessage(shortfallMetres: number): string {
  const metres = Math.round(shortfallMetres)

  if (metres < WALKABLE_SHORTFALL_METRES) {
    /*
     * Unchanged, to the character. The client's `checkInRefusal` test asserts
     * this exact sentence at 45m, and the whole point of that test is that the
     * client once tried to build its own and got it wrong.
     */
    return `You're about ${metres}m outside the check-in area. Move closer to the venue and try again.`
  }

  /*
   * Kilometres, and no "try again" — retrying from the same place cannot work,
   * so offering it is the failure mode the near sentence avoids by being
   * specific. Rounded to whole kilometres: a decimal on a 7,515km figure is
   * precision nobody asked for.
   */
  const km = Math.round(metres / 1000)
  return `You're about ${km}km from the venue, so check-in isn't available yet. Check in once you're there.`
}

/**
 * What a check-in refused on the clock says.
 *
 * The door always answered "Event has not started yet" when no day was open,
 * which on a multi-day event is wrong from day 2 on: the event started days
 * ago. Driven on staging (`blr-design-festival`, 2026-09-28): the evening after
 * day 2, with day 3 cancelled, a person standing at the venue was told the
 * festival had not started. So a multi-day event names the day — which one is
 * next, or which one was called off — in the event's own timezone.
 *
 * `ended` picks the code: `EVENT_ENDED` ("This one's over" on the phone) when
 * nothing is left to come back for, `EVENT_NOT_STARTED` otherwise. A single-day
 * event keeps its old sentences word for word.
 */
export function closedDoorMessage(
  reason: "too_early" | "too_late" | "cancelled" | "none",
  occurrence: { startTime: Date; cancelledAt: Date | null } | null,
  slots: readonly { startTime: Date; cancelledAt: Date | null }[],
  timezone: string,
  now: Date
): { message: string; ended: boolean } {
  const multiDay = slots.length > 1
  const dayOf = (s: { startTime: Date }) =>
    slots.findIndex((x) => x.startTime.getTime() === s.startTime.getTime()) + 1
  const next = slots.find((s) => !s.cancelledAt && s.startTime > now)
  const starts = (s: { startTime: Date }) => `Day ${dayOf(s)} starts ${whenIn(s.startTime, timezone)}.`

  if (reason === "too_early") {
    // Before the first day, "not started" is still the truth.
    if (!multiDay || !occurrence || dayOf(occurrence) <= 1) {
      return { message: "Event has not started yet", ended: false }
    }
    return { message: starts(occurrence), ended: false }
  }

  if (reason === "cancelled") {
    if (!multiDay || !occurrence) return { message: "This day has been cancelled", ended: true }
    const called = `Day ${dayOf(occurrence)} has been cancelled.`
    if (next) return { message: `${called} ${starts(next)}`, ended: false }
    return {
      message:
        dayOf(occurrence) === slots.length
          ? `Day ${slots.length} of ${slots.length} has been cancelled, so the event is over.`
          : "The rest of this event has been cancelled.",
      ended: true,
    }
  }

  return { message: "Event has already ended", ended: true }
}

/** "Tue, Sep 29, 12:45 AM" in the event's timezone, falling back to UTC. */
function whenIn(at: Date, timezone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timezone }).format(at)
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(at)
  }
}
