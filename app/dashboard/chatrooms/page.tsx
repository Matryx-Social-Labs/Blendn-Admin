import Link from "next/link"
import { redirect } from "next/navigation"
import { IconMessage2 } from "@tabler/icons-react"

import { LiveDot, Panel } from "@/components/dashboard/kit"
import { EmptyState } from "@/components/dashboard/primitives"
import { Button } from "@/components/ui/button"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { eventClock } from "@/lib/event-phase"
import { liveCountBucket, liveCountLabel } from "@/lib/disclosure"
import { hostsEvent, visibleEventsScope } from "@/lib/event-visibility"
import { getOccupancies } from "@/lib/occupancy"
import { canAccessDashboard } from "@/lib/rbac"
import { cn } from "@/lib/utils"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/chatrooms")

/** Matches the chat auto-archive window and the event Feedback tab. */
const FEEDBACK_WINDOW_HOURS = 24

function hoursUntil(d: Date, now: Date) {
  return Math.max(0, Math.round((d.getTime() - now.getTime()) / 3_600_000))
}

/**
 * Triage list, not a second index of every event.
 *
 * A room belongs here while its chat is open, which is two states rather than
 * one: **live** (the event is running) and **feedback** (it has ended but the
 * window is still open, and what people say in it is the honest review the
 * whole feature exists for). Each row says which, and when that changes —
 * "ends 01:15", "closes in 19h" — so the list reads as a schedule.
 *
 * The old version wrapped each room in a card with three boxed sub-panels that
 * repeated the same time twice, and stamped "Live now" on rooms whose event
 * had ended.
 */
export default async function ChatroomsPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (!canAccessDashboard(session.user.role)) redirect("/dashboard")

  const now = new Date()
  const feedbackWindowStart = new Date(now.getTime() - FEEDBACK_WINDOW_HOURS * 3_600_000)
  const isPlatformAdmin = session.user.role === "app_admin"

  // Organisation-shaped scope, the same one the events list and the two
  // overviews use. This page used to hand-roll it — and got `venues.owner_id`,
  // a column nothing writes, so every venue owner saw an empty triage screen
  // during their own live event.
  const { where: scope, actor } = await visibleEventsScope(session.user)
  const rooms = await db.events.findMany({
    where: {
      ...scope,
      status: "published",
      start_time: { lte: now },
      // Ended less than the feedback window ago, or still running.
      end_time: { gte: feedbackWindowStart },
    },
    select: {
      id: true,
      title: true,
      venue_name: true,
      city: true,
      start_time: true,
      end_time: true,
      // "ends 18:30" on the event's clock, not the server's (SCRUM-496).
      timezone: true,
      organizer: { select: { name: true } },
      organizer_id: true,
      organizer_org_id: true,
      chat_group: { select: { id: true, _count: { select: { messages: true } } } },
    },
    orderBy: [{ end_time: "asc" }, { title: "asc" }],
  })

  /*
   * Counted from check-in rows, not from a stored column. This screen and the
   * live event screen answered the same question with different numbers:
   * `lib/live-snapshot.ts` has always counted directly, while this summed
   * `events.current_capacity`. One of them was always stale.
   */
  const groupIds = rooms.flatMap((r) => (r.chat_group ? [r.chat_group.id] : []))
  const [occupancies, flagRows] = await Promise.all([
    getOccupancies(rooms.map((e) => e.id)),
    groupIds.length
      ? db.moderation_flags.groupBy({
          by: ["chat_group_id"],
          where: { chat_group_id: { in: groupIds }, status: "pending" },
          _count: { id: true },
        })
      : [],
  ])
  const flagsFor = new Map(flagRows.map((f) => [f.chat_group_id, f._count.id]))

  const live = rooms.filter((r) => r.end_time > now)
  const feedback = rooms.length - live.length
  /*
   * A room another host runs reads as a range for the venue it is in
   * (SCRUM-516): the count moves with every arrival. And then no total, which
   * minus the exact rooms would be the ranged one's count.
   */
  const ranged = (room: (typeof rooms)[number]) => !isPlatformAdmin && !hostsEvent(actor, room)
  const insideOf = (room: (typeof rooms)[number]) => {
    const n = occupancies.get(room.id)?.inside ?? 0
    return ranged(room) ? liveCountLabel(liveCountBucket(n)) : n
  }
  /*
   * The room's other figures go the same way for that venue: its messages and
   * its waiting flags as ranges, and no totals across rooms, which minus the
   * exact ones would give the ranged one back (step 15 review).
   */
  const ranges = (room: (typeof rooms)[number], n: number) => (ranged(room) ? liveCountLabel(liveCountBucket(n)) : n)
  const anyRanged = rooms.some(ranged)
  const inside = anyRanged ? null : [...occupancies.values()].reduce((sum, o) => sum + o.inside, 0)
  const flags = anyRanged ? null : [...flagsFor.values()].reduce((a, b) => a + b, 0)

  if (rooms.length === 0) {
    return (
      <EmptyState
        icon={<IconMessage2 />}
        title="No rooms open"
        description={`A room is listed here from doors until ${FEEDBACK_WINDOW_HOURS}h after the event ends.`}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* The pulse across every room. Flags waiting read first, in the
          destructive colour, because that is the one thing needing a human. */}
      {/* Gap-separated, no dots: a dot inside a span starts the next line
          with "·" once the line wraps at 375. */}
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-muted-foreground">
        <span><b className="font-bold text-foreground">{live.length}</b> live</span>
        <span><b className="font-bold text-foreground">{feedback}</b> in {feedback === 1 ? "its" : "their"} feedback window</span>
        {inside !== null ? (
          <span><b className="font-bold text-foreground">{inside}</b> {inside === 1 ? "person" : "people"} inside</span>
        ) : null}
        {flags !== null && flags > 0 ? (
          <span className="font-bold text-destructive">{flags} flag{flags === 1 ? "" : "s"} waiting</span>
        ) : null}
      </p>

      {/* A card per open room (the kit's), in the order their state changes. */}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-5">
        {rooms.map((room) => {
          const isLive = room.end_time > now
          const roomFlags = room.chat_group ? flagsFor.get(room.chat_group.id) ?? 0 : 0
          const closesAt = new Date(room.end_time.getTime() + FEEDBACK_WINDOW_HOURS * 3_600_000)
          return (
            <li key={room.id} className="flex">
              <Panel
                className="flex-1"
                title={room.title}
                action={
                  isLive ? (
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-[0.75rem] font-bold">
                      <LiveDot />
                      Live · ends {eventClock(room.timezone).time(room.end_time)}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[0.75rem] text-muted-foreground">
                      Feedback · closes in {hoursUntil(closesAt, now)}h
                    </span>
                  )
                }
              >
                <p className="-mt-2 truncate text-[0.8125rem] text-muted-foreground">
                  {[room.venue_name, room.city].filter(Boolean).join(" · ") || "Location pending"}
                  {isPlatformAdmin && room.organizer.name ? ` · ${room.organizer.name}` : ""}
                </p>
                <dl className="flex gap-6">
                  {(
                    [
                      [insideOf(room), "inside"],
                      [ranges(room, room.chat_group?._count.messages ?? 0), "messages"],
                      [ranges(room, roomFlags), "flags"],
                    ] as const
                  ).map(([value, label]) => (
                    <div key={label} className="flex flex-col-reverse">
                      <dt className="text-[0.75rem] text-faint-foreground">{label}</dt>
                      <dd
                        className={cn(
                          "text-[1.375rem] font-bold leading-[1.1] tabular-nums",
                          // Red only where the number is the room's own to see.
                          label === "flags" && !ranged(room) && roomFlags > 0 && "text-destructive"
                        )}
                      >
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                <Button asChild variant="secondary" className="self-start pointer-coarse:h-11">
                  <Link href={`/dashboard/events/${room.id}/messaging`}>
                    Open room<span className="sr-only">: {room.title}</span>
                  </Link>
                </Button>
              </Panel>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
