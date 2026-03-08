import { IconTrendingDown, IconTrendingUp } from "@tabler/icons-react"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getDashboardStats } from "./actions"

interface SectionCardsProps {
  userId?: string
  isAdmin: boolean
}

export async function SectionCards({ userId, isAdmin }: SectionCardsProps) {
  const stats = await getDashboardStats(userId)

  const TrendBadge = ({ value }: { value: number }) => (
    <Badge variant="outline">
      {value >= 0 ? <IconTrendingUp /> : <IconTrendingDown />}
      {value >= 0 ? "+" : ""}{value}%
    </Badge>
  )

  return (
    <div className="*:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card dark:*:data-[slot=card]:bg-card grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">

      {/* Total Events */}
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>{isAdmin ? "Total Events" : "My Events"}</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {stats.totalEvents.toLocaleString()}
          </CardTitle>
          <CardAction>
            <TrendBadge value={stats.eventGrowth} />
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            {stats.eventGrowth >= 0 ? "Trending up" : "Trending down"} this month{" "}
            {stats.eventGrowth >= 0 ? <IconTrendingUp className="size-4" /> : <IconTrendingDown className="size-4" />}
          </div>
          <div className="text-muted-foreground">
            {isAdmin ? "Events created in the last 6 months" : "Your events in the last 6 months"}
          </div>
        </CardFooter>
      </Card>

      {/* Total Users (admin) or Total Check-ins (non-admin) */}
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>{isAdmin ? "Total Users" : "Total Check-ins"}</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {isAdmin
              ? (stats.totalUsers ?? 0).toLocaleString()
              : (stats.totalCheckIns ?? 0).toLocaleString()}
          </CardTitle>
          {isAdmin && stats.userGrowth !== null && (
            <CardAction>
              <TrendBadge value={stats.userGrowth} />
            </CardAction>
          )}
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            {isAdmin
              ? `${stats.userGrowth !== null && stats.userGrowth >= 0 ? "Up" : "Down"} ${Math.abs(stats.userGrowth ?? 0)}% this period`
              : "Across all your events"}
          </div>
          <div className="text-muted-foreground">
            {isAdmin ? "New user registrations" : "Attendees who checked in"}
          </div>
        </CardFooter>
      </Card>

      {/* Published Events */}
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Published Events</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {stats.publishedEvents.toLocaleString()}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <IconTrendingUp />
              {stats.totalEvents > 0
                ? Math.round((stats.publishedEvents / stats.totalEvents) * 100)
                : 0}%
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            Active events <IconTrendingUp className="size-4" />
          </div>
          <div className="text-muted-foreground">
            {isAdmin ? "Events available to users" : "Your live events"}
          </div>
        </CardFooter>
      </Card>

      {/* Upcoming Events */}
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Upcoming Events</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {stats.upcomingEvents.toLocaleString()}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <IconTrendingUp />
              Coming up
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            Scheduled events <IconTrendingUp className="size-4" />
          </div>
          <div className="text-muted-foreground">
            {isAdmin ? "Events starting in the future" : "Your upcoming events"}
          </div>
        </CardFooter>
      </Card>

    </div>
  )
}
