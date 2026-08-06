import { notFound, redirect } from "next/navigation"
import { EventEditor } from "@/components/event-editor"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"
import { LiveTab } from "@/components/dashboard/live-tab"
import { EventTabs, eventTabsFor, type EventTabKey } from "./event-tabs"

/** Hours the chatroom stays open after an event for feedback. Matches the
 *  auto-archive window in the mobile chat list. */
const FEEDBACK_WINDOW_HOURS = 24

interface EventPageProps {
  params: Promise<{
    id: string
  }>
  searchParams: Promise<{ tab?: string }>
}

export default async function EventDetailPage({ params, searchParams }: EventPageProps) {
  const session = await getAuth()
  if (!session?.user) {
    redirect("/login")
  }

  const resolvedParams = await params
  const [event, categories] = await Promise.all([
    db.events.findFirst({
      where: {
        id: resolvedParams.id,
        deleted_at: null,
      },
      include: {
        details: true,
        categories: {
          include: {
            category: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: {
            created_at: "asc",
          },
        },
        media: {
          orderBy: {
            order: "asc",
          },
        },
        // eventPermissions needs the venue owner: an event at a claimed venue
        // grants that owner operational access even though they cannot edit it.
        venue: { select: { owner_org_id: true } },
      },
    }),
    db.categories.findMany({
      select: {
        id: true,
        name: true,
      },
      orderBy: {
        name: "asc",
      },
    }),
  ])

  if (!event) {
    notFound()
  }

  /*
   * Gated on operational access, not editorial. A venue owner must be able to
   * open an event held in their building — its live view, guest list and
   * chatroom — while the editor stays with whoever runs it. Gating the whole
   * page on canEdit locked them out of the event entirely.
   */
  const permissions = eventPermissions(await actorFor(session.user), event)
  if (!permissions.canOperate) {
    redirect("/dashboard/events")
  }

  const { tab: requestedTab } = await searchParams
  const feedbackWindowOpen =
    Date.now() < event.end_time.getTime() + FEEDBACK_WINDOW_HOURS * 60 * 60 * 1000
  const tabs = eventTabsFor(event.start_time.toISOString(), event.end_time.toISOString(), {
    canOperate: permissions.canOperate,
    feedbackWindowOpen,
  })
  // An unknown or now-closed tab falls back rather than 404ing — the Live tab
  // legitimately disappears mid-session when an event ends.
  const activeTab = (tabs.find((t) => t.key === requestedTab)?.key ?? "overview") as EventTabKey

  const header = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[length:var(--text-h2)] font-bold">{event.title}</h2>
          <p className="text-[0.8125rem] text-muted-foreground">
            {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(event.start_time)}
            {event.venue_name ? ` · ${event.venue_name}` : ""}
            {event.city ? `, ${event.city}` : ""}
          </p>
        </div>
        {permissions.canEdit ? null : (
          <p className="max-w-sm rounded-lg border border-border bg-card px-3.5 py-2.5 text-[0.78rem] leading-relaxed text-muted-foreground">
            <b className="font-medium text-foreground">Operational access.</b> You operate this
            venue, so you get the live view, attendees and the chatroom. Editing, publishing and
            cancelling belong to whoever runs the event.
          </p>
        )}
      </div>
      <EventTabs eventId={event.id} active={activeTab} tabs={tabs} />
    </div>
  )

  if (activeTab === "live") {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <LiveTab
          eventId={event.id}
          startAt={event.start_time.toISOString()}
          endAt={event.end_time.toISOString()}
        />
      </div>
    )
  }

  if (activeTab === "feedback") redirect(`/dashboard/events/${event.id}/feedback`)

  if (activeTab === "chat" || activeTab === "attendees") {
    // These live on the messaging route today. Kept as links rather than
    // duplicated here so there is one implementation of each, not two.
    redirect(
      activeTab === "chat"
        ? `/dashboard/events/${event.id}/messaging`
        : `/dashboard/events/${event.id}/messaging?view=${activeTab}`
    )
  }

  if (!permissions.canEdit) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <p className="text-sm text-muted-foreground">
          This event is run by someone else. Open Live or Chat to operate the room.
        </p>
      </div>
    )
  }

  const categoryIds = event.categories.map((entry) => entry.category.id)
  const primaryCategory = event.categories.find((entry) => entry.primary)?.category?.id

  return (
    <EventEditor
      categories={categories}
      initialEvent={{
        id: event.id,
        title: event.title,
        description: event.description,
        full_description: event.details?.full_description ?? event.description,
        short_description: event.short_description,
        venue_name: event.venue_name,
        venue_id: event.venue_id,
        address: event.address,
        city: event.city,
        state: event.state,
        country: event.country,
        postal_code: event.postal_code,
        start_time: event.start_time.toISOString(),
        end_time: event.end_time.toISOString(),
        timezone: event.timezone,
        status: event.status,
        visibility: event.visibility,
        max_capacity: event.max_capacity,
        latitude: event.latitude,
        longitude: event.longitude,
        cover_image_url: event.cover_image_url,
        external_link: event.external_link,
        is_featured: event.is_featured,
        check_in_radius: event.check_in_radius,
        geofence: event.geofence ?? undefined,
        category_ids: categoryIds,
        primary_category_id: primaryCategory,
        house_rules: event.details?.house_rules,
        cancellation_policy: event.details?.cancellation_policy,
        additional_info: event.details?.additional_info ?? undefined,
        faq: event.details?.faq ?? undefined,
        accessibility_info: event.details?.accessibility_info ?? undefined,
        media_items: event.media.map((item) => ({
          type: item.type,
          url: item.url,
          thumbnail_url: item.thumbnail_url,
          title: item.title,
          description: item.description,
          order: item.order,
        })),
      }}
    />
  )
}
