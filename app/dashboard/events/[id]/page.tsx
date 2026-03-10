import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { EventEditor } from "@/components/event-editor"
import { Button } from "@/components/ui/button"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { canManageEvent } from "@/lib/rbac"

interface EventPageProps {
  params: Promise<{
    id: string
  }>
}

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

  if (!canManageEvent(session.user.role, session.user.id, event.organizer_id)) {
    redirect("/dashboard/events")
  }

  const categoryIds = event.categories.map((entry) => entry.category.id)
  const primaryCategory = event.categories.find((entry) => entry.primary)?.category?.id

  return (
    <div>
      {/* Messaging shortcut banner */}
      <div className="border-b bg-muted/40 px-6 py-2 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Send announcements or set up sponsored messages for the chatroom
        </p>
        <Button size="sm" variant="outline" asChild>
          <Link href={`/dashboard/events/${resolvedParams.id}/messaging`}>
            Chatroom Messaging
          </Link>
        </Button>
      </div>
      <EventEditor
      categories={categories}
      initialEvent={{
        id: event.id,
        title: event.title,
        description: event.description,
        full_description: event.details?.full_description ?? event.description,
        short_description: event.short_description,
        venue_name: event.venue_name,
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
    </div>
  )
}
