import { getAuth } from "@/lib/auth"
import { ChartAreaInteractive } from "./chart-area-interactive"
import { EventsTable } from "./events-table"
import { SectionCards } from "./section-cards"
import { getEventsOverTime, getRecentEvents } from "./actions"

// Force dynamic rendering - requires database at runtime
export const dynamic = 'force-dynamic'

export default async function Page() {
  const session = await getAuth()
  const isAdmin = session?.user?.role === "app_admin"
  const userId = isAdmin ? undefined : session?.user?.id

  const [eventsOverTime, recentEvents] = await Promise.all([
    getEventsOverTime(90, userId),
    getRecentEvents(50, userId),
  ])

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <SectionCards userId={userId} isAdmin={isAdmin} />
      <div className="px-4 lg:px-6">
        <ChartAreaInteractive data={eventsOverTime} />
      </div>
      <EventsTable data={recentEvents} />
    </div>
  )
}
