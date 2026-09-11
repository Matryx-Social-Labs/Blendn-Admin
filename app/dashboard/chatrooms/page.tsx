import Link from "next/link"
import { redirect } from "next/navigation"
import { IconMessage2 } from "@tabler/icons-react"

import { EmptyState } from "@/components/dashboard/primitives"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { visibleEventsWhere } from "@/lib/event-visibility"
import { getOccupancies } from "@/lib/occupancy"
import { canAccessDashboard } from "@/lib/rbac"

/** Matches the chat auto-archive window and the event Feedback tab. */
const FEEDBACK_WINDOW_HOURS = 24

const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" })

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
  const scope = await visibleEventsWhere(session.user)
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
      organizer: { select: { name: true } },
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
  const inside = [...occupancies.values()].reduce((sum, o) => sum + o.inside, 0)
  const flags = [...flagsFor.values()].reduce((a, b) => a + b, 0)

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
    <div className="flex flex-col gap-2">
      {/* The pulse across every room. Flags waiting read first, in the
          destructive colour, because that is the one thing needing a human. */}
      <p className="flex flex-wrap gap-x-1.5 text-[0.8125rem] text-muted-foreground">
        <span><b className="font-bold text-foreground">{live.length}</b> live</span>
        <span>· <b className="font-bold text-foreground">{feedback}</b> in {feedback === 1 ? "its" : "their"} feedback window</span>
        <span>· <b className="font-bold text-foreground">{inside}</b> people inside</span>
        {flags > 0 ? (
          <span className="font-bold text-destructive">· {flags} flag{flags === 1 ? "" : "s"} waiting</span>
        ) : null}
      </p>

      <ul className="flex flex-col divide-y divide-border">
        {rooms.map((room) => {
          const isLive = room.end_time > now
          const roomFlags = room.chat_group ? flagsFor.get(room.chat_group.id) ?? 0 : 0
          const closesAt = new Date(room.end_time.getTime() + FEEDBACK_WINDOW_HOURS * 3_600_000)
          return (
            <li key={room.id}>
              {/* The row is the link. One place to click, no button. */}
              <Link
                href={`/dashboard/events/${room.id}/messaging`}
                className="grid gap-x-4 gap-y-1 py-4 @2xl/main:grid-cols-[minmax(0,1fr)_200px_260px] @2xl/main:items-baseline hover:bg-accent/40 -mx-2 px-2 rounded-md"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-bold">{room.title}</span>
                  <span className="truncate text-[0.8125rem] text-muted-foreground">
                    {[room.venue_name, room.city].filter(Boolean).join(" · ") || "Location pending"}
                    {isPlatformAdmin && room.organizer.name ? ` · ${room.organizer.name}` : ""}
                  </span>
                </span>
                <span className="text-[0.8125rem]">
                  {isLive ? (
                    <>
                      <b className="font-bold text-success">Live</b> · ends {time.format(room.end_time)}
                    </>
                  ) : (
                    <>
                      <b className="font-bold">Feedback</b> · closes in {hoursUntil(closesAt, now)}h
                    </>
                  )}
                </span>
                <span className="flex flex-wrap gap-x-3.5 text-[0.8125rem] text-muted-foreground @2xl/main:justify-end">
                  <span>
                    <b className="font-bold text-foreground">{occupancies.get(room.id)?.inside ?? 0}</b> inside
                  </span>
                  <span>
                    <b className="font-bold text-foreground">{room.chat_group?._count.messages ?? 0}</b> messages
                  </span>
                  {roomFlags > 0 ? (
                    <span className="font-bold text-destructive">
                      {roomFlags} flag{roomFlags === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
