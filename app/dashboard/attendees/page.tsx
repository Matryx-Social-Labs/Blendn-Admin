import { redirect } from "next/navigation"

import { KpiStrip } from "@/components/dashboard/kit"
import { getAuth } from "@/lib/auth"
import { attendeeRoster } from "@/lib/attendee-roster"
import { formatNumber, formatPct } from "@/lib/dashboard-format"

import { AttendeesTable } from "./attendees-table"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/attendees")

export const dynamic = "force-dynamic"

/**
 * Organiser: who comes back, and who RSVPs but doesn't show -- each attendee
 * by the label the Attendees export uses, never by name.
 *
 * Repeat attendance is the loyalty signal and no-shows are the capacity
 * planning one; neither had a home before this screen.
 */
export default async function AttendeesPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role === "app_admin") redirect("/dashboard/users")
  if (session.user.role !== "organizer") redirect("/dashboard")

  /*
   * Labels and counts, never names (SCRUM-383 b). The roster is built in
   * `lib/attendee-roster.ts` so the rule lives in the query, where an
   * integration test can hold it, rather than in what this page chooses to
   * render. An admin never reaches this: they have `/dashboard/users`.
   */
  const { rows, uniqueAttendees, repeatCount, noShowPct } = await attendeeRoster(
    session.user.role,
    session.user.id
  )

  return (
    <div className="flex flex-col gap-5">
      {/* Every figure here is free and stays free (pricing audit §6.1). */}
      <KpiStrip
        items={[
          { label: "Unique attendees", value: formatNumber(uniqueAttendees), hint: "checked in at least once" },
          {
            label: "Came back",
            value: repeatCount,
            hint:
              uniqueAttendees === 0
                ? "needs 2+ events"
                : `${Math.round((repeatCount / uniqueAttendees) * 100)}% of attendees`,
          },
          {
            label: "No-show rate",
            value: noShowPct === null ? null : formatPct(noShowPct),
            hint: noShowPct === null ? "needs a past event" : "committed RSVPs who didn't check in",
          },
        ]}
      />

      <AttendeesTable rows={rows} />
    </div>
  )
}
