"use client"

import { Plus, X } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import { Panel } from "@/components/dashboard/kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { refusalMessage } from "@/lib/refusal"
import { setVenueHours } from "@/lib/venue-actions"
import { DAY_NAMES, hoursProblems, type VenueHours } from "@/lib/venue-hours"

type Opening = { open: string; close: string }
type Field = "open" | "close"

/** The week as a person reads it. `day` stays Sunday-first, as stored. */
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0]
/** What a newly added day starts with when the week has no other opening to copy. */
const FIRST_OPENING: Opening = { open: "18:00", close: "23:00" }
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

/** "closes Saturday morning" for a close past midnight; midnight is said as midnight. */
function closesWords(day: number, { open, close }: Opening): string | null {
  if (!CLOCK.test(open) || !CLOCK.test(close)) return null
  if (close === "00:00") return "closes at midnight"
  return close < open ? `closes ${DAY_NAMES[(day + 1) % 7]} morning` : null
}

/** Each day's field error: a blank time first, then the rules the server applies (`hoursProblems`). */
function problemsOf(week: (Opening | null)[], resetHour: number): Map<number, { field: Field; message: string }> {
  const out = new Map<number, { field: Field; message: string }>()
  week.forEach((o, day) => {
    if (!o) return
    if (!CLOCK.test(o.open)) out.set(day, { field: "open", message: `Pick when ${DAY_NAMES[day]} opens.` })
    else if (!CLOCK.test(o.close)) out.set(day, { field: "close", message: `Pick when ${DAY_NAMES[day]} closes.` })
  })
  const rows = week.flatMap((o, day) => (o && !out.has(day) ? [{ day, ...o }] : []))
  for (const p of hoursProblems(rows, resetHour)) out.set(rows[p.index].day, { field: p.field, message: p.message })
  return out
}

/**
 * Opening hours on the venue page (SCRUM-1154): one opening a day or Closed,
 * on the venue's own clock with no zone named, saved as the week the app reads
 * (`venues.hours`). Saves on its own, like "In the app": one fact with its own
 * audit row. The page remounts it on the stored week after a save.
 */
export function VenueHoursPanel({ venueId, hours, resetHour }: { venueId: string; hours: VenueHours | null; resetHour: number }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [week, setWeek] = useState<(Opening | null)[]>(() =>
    DAY_NAMES.map((_, day) => {
      const row = hours?.find((h) => h.day === day)
      return row ? { open: row.open, close: row.close } : null
    })
  )
  // Where focus goes after an add or a remove, so a keyboard user is not dropped to the top of the page.
  const [focusId, setFocusId] = useState<string | null>(null)
  useEffect(() => {
    if (focusId) document.getElementById(focusId)?.focus()
  }, [focusId])

  const problems = problemsOf(week, resetHour)
  const given = week.some(Boolean)
  const setDay = (day: number, opening: Opening | null) => setWeek((w) => w.map((o, d) => (d === day ? opening : o)))

  const add = (day: number) => {
    setDay(day, MONDAY_FIRST.map((d) => week[d]).find((o): o is Opening => o !== null) ?? FIRST_OPENING)
    setFocusId(`hours-${day}-open`)
  }
  const remove = (day: number) => {
    setDay(day, null)
    setFocusId(`hours-${day}-add`)
  }
  const save = () => {
    const first = MONDAY_FIRST.find((d) => problems.has(d))
    if (first !== undefined) {
      document.getElementById(`hours-${first}-${problems.get(first)!.field}`)?.focus()
      return
    }
    start(async () => {
      try {
        await setVenueHours(venueId, week.flatMap((o, day) => (o ? [{ day, ...o }] : [])))
        toast.success("Opening hours saved")
        router.refresh()
      } catch (error) {
        toast.error(refusalMessage(error, "Could not save the hours"))
      }
    })
  }

  return (
    <Panel title="Opening hours" hint="on the venue’s clock · shown in the app">
      {given ? null : (
        <p className="text-[0.8125rem] text-muted-foreground">Not given yet. The app shows no hours for this place until you add them.</p>
      )}
      <ul className="flex flex-col">
        {MONDAY_FIRST.map((day) => {
          const name = DAY_NAMES[day]
          const opening = week[day]
          const problem = problems.get(day)
          const words = opening && !problem ? closesWords(day, opening) : null
          const describe = (field: Field) =>
            [problem?.field === field ? `hours-${day}-error` : null, field === "close" && words ? `hours-${day}-words` : null].filter(Boolean).join(" ") || undefined
          return (
            <li
              key={day}
              role="group"
              aria-labelledby={`hours-day-${day}`}
              className="grid gap-x-3 gap-y-1.5 border-t border-border py-2.5 first:border-t-0 @md/main:grid-cols-[7rem_minmax(0,1fr)]"
            >
              <span id={`hours-day-${day}`} className="text-[0.875rem] font-semibold @md/main:pt-2">{name}</span>
              {opening ? (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {(["open", "close"] as const).map((field) => (
                      <span key={field} className="contents">
                        {field === "close" ? <span className="text-[0.8125rem] text-muted-foreground">to</span> : null}
                        <Input
                          id={`hours-${day}-${field}`}
                          type="time"
                          aria-label={`${name} ${field === "open" ? "opens" : "closes"}`}
                          value={opening[field]}
                          onChange={(e) => setDay(day, { ...opening, [field]: e.target.value })}
                          invalid={problem?.field === field}
                          aria-describedby={describe(field)}
                          disabled={pending}
                          className="w-[7.75rem] tabular-nums"
                        />
                      </span>
                    ))}
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${name} hours`} onClick={() => remove(day)} disabled={pending}>
                      <X aria-hidden="true" />
                    </Button>
                  </div>
                  {words ? <p id={`hours-${day}-words`} className="text-[0.75rem] text-muted-foreground">{words}</p> : null}
                  {problem ? <p id={`hours-${day}-error`} className="text-[0.75rem] text-destructive">{problem.message}</p> : null}
                </div>
              ) : (
                <div className="flex min-h-9 flex-wrap items-center gap-3">
                  {given ? <span className="text-[0.8125rem] text-muted-foreground">Closed</span> : null}
                  <Button id={`hours-${day}-add`} type="button" variant="outline" size="sm" aria-label={`Add ${name} hours`} onClick={() => add(day)} disabled={pending}>
                    <Plus aria-hidden="true" />
                    Add hours
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-border pt-3.5">
        <Button type="button" onClick={save} disabled={pending}>
          Save hours
        </Button>
        <p className="text-[0.75rem] text-faint-foreground">
          {given ? "A day with no hours shows as closed. " : null}A night can run until {String(resetHour).padStart(2, "0")}:00, when the venue’s next day starts.
        </p>
      </div>
    </Panel>
  )
}
