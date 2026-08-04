import Link from "next/link"
import { redirect } from "next/navigation"
import {
  IconArrowRight,
  IconCalendarEvent,
  IconClock,
  IconMapPin,
  IconMessage2,
  IconUsers,
} from "@tabler/icons-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canAccessDashboard } from "@/lib/rbac"

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
})

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
})

function formatTimeWindow(start: Date, end: Date) {
  return `${timeFormatter.format(start)} - ${timeFormatter.format(end)}`
}

function formatSchedule(start: Date, end: Date) {
  return `${dateFormatter.format(start)} · ${formatTimeWindow(start, end)}`
}

function formatLocation(venueName: string | null, city: string | null) {
  return [venueName, city].filter(Boolean).join(" · ") || "Location pending"
}

export default async function ChatroomsPage() {
  const session = await getAuth()
  if (!session?.user) {
    redirect("/login")
  }

  if (!canAccessDashboard(session.user.role)) {
    redirect("/dashboard")
  }

  const now = new Date()
  // Scope to owned events for everyone except app_admin. venue_owner used to be
  // bounced off this page entirely, which contradicted `canModerateChat` and
  // the messaging page's own `canManageEvent` gate — both already allow a venue
  // owner to moderate their own events.
  const isPlatformAdmin = session.user.role === "app_admin"
  const liveEvents = await db.events.findMany({
    where: {
      deleted_at: null,
      status: "published",
      start_time: { lte: now },
      end_time: { gte: now },
      ...(isPlatformAdmin ? {} : { organizer_id: session.user.id }),
    },
    select: {
      id: true,
      title: true,
      venue_name: true,
      city: true,
      start_time: true,
      end_time: true,
      current_capacity: true,
      max_capacity: true,
      organizer: {
        select: {
          name: true,
        },
      },
      chat_group: {
        select: {
          id: true,
          member_count: true,
          _count: {
            select: {
              messages: true,
            },
          },
        },
      },
    },
    orderBy: [{ start_time: "asc" }, { title: "asc" }],
  })

  const liveCount = liveEvents.length
  const chatroomCount = liveEvents.filter((event) => event.chat_group).length
  const audienceOnSite = liveEvents.reduce((sum, event) => sum + event.current_capacity, 0)

  return (
    <div className="flex flex-col gap-6 py-6">
      <div className="px-4 lg:px-6">
        <div className="rounded-xl border bg-card px-6 py-6">
          <Badge className="rounded-full px-3 py-1 font-medium">
            Live event messaging
          </Badge>
          <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-foreground">Chatrooms</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Choose a live event to review the chat feed, send announcements, and manage
                sponsored messages from one workspace.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border bg-muted px-4 py-4">
                <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  Live now
                </p>
                <p className="mt-2 text-2xl font-semibold text-foreground">{liveCount}</p>
              </div>
              <div className="rounded-lg border bg-muted px-4 py-4">
                <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  Chatrooms ready
                </p>
                <p className="mt-2 text-2xl font-semibold text-foreground">{chatroomCount}</p>
              </div>
              <div className="rounded-lg border bg-muted px-4 py-4">
                <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  Audience on site
                </p>
                <p className="mt-2 text-2xl font-semibold text-foreground">{audienceOnSite}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6">
        {liveEvents.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-muted/30 px-6 py-12 text-center">
            <div className="mx-auto flex max-w-md flex-col items-center gap-4">
              <div className="rounded-full border bg-muted p-4">
                <IconMessage2 className="size-6 text-foreground" />
              </div>
              <div className="space-y-2">
                <h2 className="text-2xl font-semibold text-foreground">No live events right now</h2>
                <p className="text-sm leading-6 text-muted-foreground">
                  This page lists only events that are currently in progress. Once an event goes
                  live, you can open its chatroom workspace from here.
                </p>
              </div>
              <Button asChild variant="outline" className="rounded-full px-5">
                <Link href="/dashboard/events">View all events</Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {liveEvents.map((event) => {
              const attendeeSummary = event.max_capacity
                ? `${event.current_capacity}/${event.max_capacity} on site`
                : `${event.current_capacity} on site`

              return (
                <Card key={event.id} className="shadow-none">
                  <CardContent className="space-y-5 px-6 py-6">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                          <Badge className="rounded-full px-3 py-1 font-medium">
                            Live now
                          </Badge>
                          <Badge variant="outline" className="rounded-full px-3 py-1">
                            {event.chat_group ? "Chatroom active" : "Chatroom pending"}
                          </Badge>
                        </div>
                        <div>
                          <h2 className="text-2xl font-semibold text-foreground">{event.title}</h2>
                          <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            {formatLocation(event.venue_name, event.city)}
                            {session.user.role === "app_admin" && event.organizer.name
                              ? ` · ${event.organizer.name}`
                              : ""}
                          </p>
                        </div>
                      </div>
                      <div className="rounded-full border bg-muted p-3">
                        <IconMessage2 className="size-5 text-foreground" />
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-lg border bg-muted p-4">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <IconCalendarEvent className="size-4" />
                          <span className="text-xs font-semibold uppercase tracking-[0.18em]">
                            Schedule
                          </span>
                        </div>
                        <p className="mt-2 text-sm text-foreground">
                          {formatSchedule(event.start_time, event.end_time)}
                        </p>
                      </div>
                      <div className="rounded-lg border bg-muted p-4">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <IconClock className="size-4" />
                          <span className="text-xs font-semibold uppercase tracking-[0.18em]">
                            Window
                          </span>
                        </div>
                        <p className="mt-2 text-sm text-foreground">
                          {formatTimeWindow(event.start_time, event.end_time)}
                        </p>
                      </div>
                      <div className="rounded-lg border bg-muted p-4">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <IconUsers className="size-4" />
                          <span className="text-xs font-semibold uppercase tracking-[0.18em]">
                            Attendance
                          </span>
                        </div>
                        <p className="mt-2 text-sm text-foreground">{attendeeSummary}</p>
                      </div>
                    </div>

                    <div className="flex flex-col gap-4 rounded-lg border bg-muted p-4 md:flex-row md:items-center md:justify-between">
                      <div className="space-y-1">
                        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                          Messaging readiness
                        </p>
                        <p className="text-sm leading-6 text-foreground">
                          {event.chat_group
                            ? `${event.chat_group._count.messages} messages in the live room.`
                            : "The room appears after the first attendee joins from the mobile app."}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <IconMapPin className="size-4" />
                        <span>
                          {event.chat_group?.member_count ?? 0} members in chat
                        </span>
                      </div>
                    </div>

                    <Button asChild className="h-11 rounded-full px-5">
                      <Link href={`/dashboard/events/${event.id}/messaging`}>
                        Open chatroom
                        <IconArrowRight className="size-4" />
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
