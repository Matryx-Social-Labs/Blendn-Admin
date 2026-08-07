import { notFound, redirect } from "next/navigation"
import { EventEditor } from "@/components/event-editor"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"


interface EventPageProps {
  params: Promise<{ id: string }>
}

/**
 * The staged editor.
 *
 * Split out of `/dashboard/events/[id]`, which used to *be* this form — opening
 * an event to see how it was doing put you in a seven-stage editor. That page
 * is now the Overview, and this is where you go to change something.
 */
export default async function EditEventPage({ params }: EventPageProps) {
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

  // The editor is editors-only. A venue owner reaching this URL directly gets
  // sent back to the Overview, which is the screen that actually serves them.
  if (!permissions.canEdit) {
    redirect(`/dashboard/events/${event.id}`)
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
