import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { UserEventsTable } from "@/components/user-events-table"
import { SectionTitle } from "@/components/dashboard/primitives"
import { format } from "date-fns"

/**
 * One host account, for an admin.
 *
 * Shared by the organiser and venue-owner detail pages, which were the same
 * sixty lines twice — each with its own `h1` under the site header's, a "Back
 * to" button the sidebar already provides, and the old `py-6 px-4` frame.
 */
export function RoleUserDetail({
  user,
  kind,
}: {
  user: {
    name: string | null
    email: string
    image: string | null
    createdAt: Date
    organized_events: Parameters<typeof UserEventsTable>[0]["events"]
  }
  kind: "Organiser" | "Venue owner"
}) {
  const initials = user.name
    ? user.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
    : user.email[0].toUpperCase()
  const n = user.organized_events.length

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Avatar className="size-10">
          <AvatarImage src={user.image ?? ""} alt="" />
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <h2 className="text-[length:var(--text-h2)] font-bold">{user.name ?? `Unnamed ${kind.toLowerCase()}`}</h2>
            <span className="text-[0.8125rem] text-muted-foreground">
              {kind.toLowerCase()} · joined {format(user.createdAt, "d MMM yyyy")}
            </span>
          </div>
          <span className="truncate text-[0.8125rem] text-muted-foreground">{user.email}</span>
        </div>
      </div>

      <section className="flex flex-col gap-3 border-t border-border pt-5">
        <SectionTitle hint={`${n} created`}>Events</SectionTitle>
        <UserEventsTable events={user.organized_events} isAdmin />
      </section>
    </div>
  )
}
