import { ChartAreaInteractive } from "./chart-area-interactive"
import { EventsTable } from "./events-table"
import { SectionCards } from "./section-cards"
import { getEventsOverTime, getRecentEvents } from "./actions"

// Force dynamic rendering - requires database at runtime
export const dynamic = 'force-dynamic'

export default async function Page() {
  const [eventsOverTime, recentEvents] = await Promise.all([
    getEventsOverTime(90),
    getRecentEvents(50),
  ])

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <SectionCards />
      <div className="px-4 lg:px-6">
        <ChartAreaInteractive data={eventsOverTime} />
      </div>
      <EventsTable data={recentEvents} />
    </div>
  )
}
