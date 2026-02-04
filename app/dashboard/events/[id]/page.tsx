import { notFound } from "next/navigation"
import { EventEditor } from "@/components/event-editor"
import { db } from "@/lib/db"

interface EventPageProps {
  params: Promise<{
    id: string
  }>
}

export default async function EditEventPage({ params }: EventPageProps) {
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
        current_capacity: event.current_capacity,
        latitude: event.latitude,
        longitude: event.longitude,
        cover_image_url: event.cover_image_url,
        external_link: event.external_link,
        is_featured: event.is_featured,
        is_recurring: event.is_recurring,
        check_in_radius: event.check_in_radius,
        category_ids: categoryIds,
        primary_category_id: primaryCategory,
        house_rules: event.details?.house_rules,
        cancellation_policy: event.details?.cancellation_policy,
        additional_info: event.details?.additional_info ?? undefined,
        faq: event.details?.faq ?? undefined,
        accessibility_info: event.details?.accessibility_info ?? undefined,
        covid_guidelines: event.details?.covid_guidelines,
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
