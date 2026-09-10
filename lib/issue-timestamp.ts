/**
 * When an issue opened, said in a way that cannot be read as today.
 *
 * The live tab rendered `toLocaleTimeString(...)` — time of day, no date —
 * under a heading reading *"Tonight's issues"*. `issuesFor` is not scoped to
 * tonight: it returns the event's whole history, newest open first.
 *
 * Measured on staging, on a run that spans a month:
 *
 * | opened | rendered | actually |
 * |---|---|---|
 * | 2026-09-09 17:54Z | `19:54` | **yesterday** |
 * | 2026-09-04 22:04Z | `00:04` | **six days ago** |
 *
 * The first is the sharp one. The panel sat beside a room clock reading 19:47,
 * so "19:54" read as *seven minutes from now* — an issue that had been open for
 * a day looked like one that had not started yet. The duration beside it said
 * "ongoing 23h 53m", so the two halves of one line disagreed.
 *
 * The date is added only when it is needed. A one-night event is the ordinary
 * case and `21:40 · lasted 12 min` is the right density for it; bolting a date
 * onto every row to cover the multi-day case would make the common one worse.
 */
export function issueOpenedLabel(openedAt: string, now: Date = new Date()): string {
  const opened = new Date(openedAt)
  const time = opened.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })

  /*
   * Calendar day, not elapsed hours. An issue that opened at 23:50 and is read
   * at 00:10 is twenty minutes old and still wants a date, because "23:50"
   * under a clock reading "00:10" is the same ambiguity in miniature.
   */
  const sameDay =
    opened.getFullYear() === now.getFullYear() &&
    opened.getMonth() === now.getMonth() &&
    opened.getDate() === now.getDate()
  if (sameDay) return time

  const date = opened.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
  return `${date}, ${time}`
}

/**
 * The recorded issues worth listing under the live alerts.
 *
 * Alerts and the issue log run the same seven rules — one derived from the
 * current snapshot, one recorded by the server sweep — so an open issue whose
 * condition is still true renders twice, one panel below the other, word for
 * word. On staging "Leaving early" appeared under **Alerts** and again in the
 * log with an identical body.
 *
 * Filtered on `kind`, not on `resolvedAt === null`. An issue the sweep still
 * has open but the current snapshot no longer derives — the condition cleared
 * between sweeps, or the tab was opened after it stopped — is exactly what this
 * panel exists to surface, and a blanket "hide the open ones" would swallow it.
 */
export function earlierIssues<T extends { kind: string; resolvedAt: string | null }>(
  issues: readonly T[],
  liveAlertKinds: readonly string[]
): T[] {
  const live = new Set(liveAlertKinds)
  return issues.filter((i) => i.resolvedAt !== null || !live.has(i.kind))
}
