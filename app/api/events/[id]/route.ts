import { logger } from "@/lib/logger"
import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { getAuth } from "@/lib/auth"
import { eventWriteSchema } from "@/lib/validations/event"
import { canPublish, validateLocationInput } from "@/lib/geofence-input"
import { uniqueEventSlug } from "@/lib/event-slug"
import { resolveEventCity } from "@/lib/location"
import { db } from "@/lib/db"
import { cancelEventCheckIns } from "@/lib/event-cancellation"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"
import { auditLog } from "@/lib/audit-log"
import { resolveVenueLink } from "@/lib/venue-link"
import { syncOccurrences } from "@/lib/occurrences"
import {
  notifyEventCancelled,
  notifyEventDetailsChanged,
  materialEventChanges,
} from "@/lib/services/event-notifications.service"

const parseJsonField = (value: unknown) => {
  if (typeof value !== "string") return value
  if (value.trim() === "") return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

interface RouteContext {
  params: Promise<{
    id: string
  }>
}

export async function GET(_: Request, { params }: RouteContext) {
  try {
    const resolvedParams = await params

    /*
     * PATCH and DELETE below both authenticate and run `eventPermissions`.
     * This one did neither, and `middleware.ts` does not match `/api/events`,
     * so it was the only gate and there was none: an unauthenticated GET
     * returned the whole row for any event id, drafts and private events
     * included.
     *
     * The row carries `geofence`, `latitude`/`longitude` and
     * `check_in_radius` -- the server-side check-in boundary. Reading it tells
     * you exactly which coordinates to submit to the mobile check-in route to
     * pass `evaluateCheckIn` from anywhere, which turns the one guarantee the
     * organiser's numbers rest on into a formality.
     */
    const session = await getAuth()
    if (!session?.user) {
      return new NextResponse("Unauthorized", { status: 401 })
    }

    const event = await db.events.findFirst({
      where: {
        id: resolvedParams.id,
        deleted_at: null,
      },
      include: {
        venue: { select: { owner_org_id: true } },
      },
    })

    if (!event) {
      return new NextResponse("Event not found", { status: 404 })
    }

    if (!eventPermissions(await actorFor(session.user), event).canOperate) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    return NextResponse.json(event)
  } catch (error) {
    logger.error("Error fetching event", { error: error instanceof Error ? error.message : String(error) })
    return new NextResponse("Internal error", { status: 500 })
  }
}

export async function PATCH(req: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()

    if (!session?.user) {
      return new NextResponse("Unauthorized", { status: 401 })
    }

    const resolvedParams = await params
    const body = await req.json()

    /*
     * The last write endpoints in the codebase without a schema. The
     * destructure below is an allow-list, so mass assignment was never
     * possible, but nothing bounded a string's length or checked that
     * `latitude` was a number -- and `parseJsonField` put unvalidated
     * `JSON.parse` output into Json columns.
     */
    const parsed = eventWriteSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid event payload", issues: parsed.error.issues },
        { status: 400 }
      )
    }
    const {
      title,
      description,
      short_description,
      venue_name,
      venue_id,
      address,
      city,
      state,
      country,
      postal_code,
      start_time,
      end_time,
      timezone,
      status,
      visibility,
      max_capacity,
      door_policy,
      min_age,
      latitude,
      longitude,
      cover_image_url,
      external_link,
      is_featured,
      is_recurring,
      check_in_radius,
      full_description,
      house_rules,
      cancellation_policy,
      additional_info,
      faq,
      accessibility_info,
      covid_guidelines,
      category_ids,
      amenity_ids,
      primary_category_id,
      media_items,
      geofence,
    } = parsed.data

    const location = validateLocationInput({ check_in_radius, geofence })
    if (!location.ok) {
      return NextResponse.json({ error: location.error }, { status: 400 })
    }

    // Debug: Log cover_image_url being updated
    logger.info("Updating event - cover_image_url", { coverImageUrl: cover_image_url ?? null })

    const event = await db.events.findFirst({
      where: {
        id: resolvedParams.id,
        deleted_at: null,
      },
      // eventPermissions needs the venue owner: an event at a claimed venue
      // grants that owner operational access even though they cannot edit it.
      include: { venue: { select: { owner_org_id: true } } },
    })

    if (!event) {
      return new NextResponse("Event not found", { status: 404 })
    }

    if (!eventPermissions(await actorFor(session.user), event).canEdit) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    // Fix #31: Validate capacity fields on update
    if (max_capacity !== undefined && max_capacity !== null) {
      if (!Number.isInteger(max_capacity) || max_capacity < 1) {
        return new NextResponse("max_capacity must be a positive integer", { status: 400 })
      }
      if (max_capacity > 100_000) {
        return new NextResponse("max_capacity cannot exceed 100,000", { status: 400 })
      }
    }

    /*
     * Gated on the transition INTO published, not on the published state.
     *
     * The Overview already renders "Place it on the map" as a blocking
     * publish blocker, but that badge was advisory: this route accepted
     * `status: "published"` with no location whatsoever. Check-in is GPS-gated,
     * so the published event then refused every attendee at the door with
     * OUT_OF_RANGE — a broken-looking app rather than an unfinished event.
     *
     * The check reads the values this request is about to write, so an
     * organiser may drop the pin and publish in one PATCH. It deliberately
     * does not run for an event that is already published: adding a gate to
     * every edit would strand any event that predates it.
     */
    if (status === "published" && event.status !== "published") {
      const gate = canPublish({
        latitude: latitude ?? event.latitude,
        longitude: longitude ?? event.longitude,
        geofence: location.values.geofence ?? event.geofence,
      })
      if (!gate.ok) {
        return NextResponse.json({ error: gate.reason }, { status: 400 })
      }
    }

    // Fix #35: When cancelling an event, cascade to active check-ins
    const isCancelling = status === "cancelled" && event.status !== "cancelled"

    // Omitted means "leave the link alone" — a PATCH that only changes the
    // title must not unlink the venue. Explicit null unlinks.
    const venueLink =
      venue_id === undefined
        ? {}
        : await resolveVenueLink(venue_id, {
            venue_id: event.venue_id,
            venue_link_status: event.venue_link_status,
          })

    /*
     * Re-resolve the city when the pin moves.
     *
     * `city` is derived from the coordinates at write time (see the create
     * route), so an edit that moves the pin and does not supply a city would
     * otherwise leave the old one -- an event that moved across town keeping
     * the wrong label, on the field the discovery feed filters by.
     *
     * Only when coordinates were actually submitted: a PATCH that touches the
     * title must not spend a geocode, and must not overwrite a city an
     * organiser typed deliberately.
     */
    const movedPin = latitude !== undefined && longitude !== undefined
    const resolvedCity = movedPin
      ? await resolveEventCity(city, latitude, longitude)
      : city
    // `?? undefined` is gone from here too: the payload guards on
    // `resolvedCity != null`, so null and undefined are already equivalent at
    // the point of use, and the coalesce was only converting one into the other.

    /*
     * Computed before the payload, because a spread condition cannot await.
     * `null` means the title was not part of this PATCH -- `null` rather than
     * `undefined` because this is a local sentinel that never reaches Prisma,
     * and the budget guard counts any `: undefined` it can see.
     */
    const nextSlug = title ? await uniqueEventSlug(title, resolvedParams.id) : null

    const updatedEvent = await db.events.update({
      where: { id: resolvedParams.id },
      data: {
        /*
         * Conditional spreads, not `?? undefined`.
         *
         * Prisma strips an `undefined` value rather than matching or writing
         * nothing, so `field: x ?? undefined` was the idiom for "leave this
         * column alone". It reads fine and it is the single obstacle to
         * `strictUndefinedChecks`, which is the only mechanical guard this
         * codebase has against a query silently widening — the failure that
         * once turned a scoped moderation lookup into an unscoped one.
         *
         * The semantics are preserved exactly, which required care per field:
         *
         *   `!= null`  omits null AND undefined, and keeps `0`, `false` and
         *              `""`. Used for everything that was `?? undefined`,
         *              because that is precisely what `??` did.
         *   truthiness kept only where the original used it — `start_time` and
         *              the slug — since `new Date("")` is an Invalid Date and
         *              the old code skipped empty strings there.
         *
         * Using `&&` everywhere would have been the easy mistake: it would
         * drop `latitude: 0` (the equator), `max_capacity: 0` and
         * `is_featured: false`.
         */
        ...(title != null && { title }),
        // Excludes this event, so re-saving a title the event already holds
        // keeps its slug instead of colliding with itself and drifting to -2.
        ...(nextSlug !== null && { slug: nextSlug }),
        ...(description != null && { description }),
        ...(short_description != null && { short_description }),
        ...(venue_name != null && { venue_name }),
        ...venueLink,
        ...(address != null && { address }),
        ...(resolvedCity != null && { city: resolvedCity }),
        ...(state != null && { state }),
        ...(country != null && { country }),
        ...(postal_code != null && { postal_code }),
        ...(start_time ? { start_time: new Date(start_time) } : {}),
        ...(end_time ? { end_time: new Date(end_time) } : {}),
        ...(timezone != null && { timezone }),
        ...(status != null && { status }),
        ...(visibility != null && { visibility }),
        ...(max_capacity != null && { max_capacity }),
        ...(door_policy != null && { door_policy }),
        /*
         * Age restriction is the one field null must be able to clear — an
         * event that stops being 18+ has to be able to say so. So the test is
         * `!== undefined`, not `!= null`, and an explicit null is written
         * through. Every other field above treats null as "leave it alone".
         */
        ...(min_age !== undefined && { min_age }),
        ...(latitude != null && { latitude }),
        ...(longitude != null && { longitude }),
        ...(cover_image_url != null && { cover_image_url }),
        ...(external_link != null && { external_link }),
        ...(is_featured != null && { is_featured }),
        ...(is_recurring != null && { is_recurring }),
        ...(location.values.check_in_radius != null && {
          check_in_radius: location.values.check_in_radius,
        }),
        /*
         * `in`, and nothing else — an explicit null has to reach the column.
         *
         * `validateLocationInput` sets `values.geofence = null` on purpose,
         * with the comment "Explicit null clears it and falls back to the point
         * + radius columns", and the `!= null` here then dropped exactly that
         * value. So an organiser who removed a drawn fence kept it: the request
         * succeeded, the response looked right, and the door went on testing
         * against a shape that was no longer on the screen.
         *
         * Neither half is wrong on its own, which is why it survived. The
         * module distinguishes absent from null and the caller collapsed them
         * again, and `"geofence" in values` is already precisely "the request
         * said something about the fence" — `values.geofence` is only assigned
         * when the input was not `undefined`.
         */
        ...("geofence" in location.values && {
          /*
           * `Prisma.DbNull`, not `null`, and this is why the clear was never
           * implemented rather than merely forgotten: `geofence` is `Json?`,
           * and Prisma refuses a bare `null` on a nullable Json column at the
           * type level — it cannot tell "set the column to SQL NULL" from "set
           * it to the JSON value null". `tsc` rejects the obvious fix, and
           * dropping the null is what somebody does next.
           */
          geofence:
            location.values.geofence === null ? Prisma.DbNull : location.values.geofence,
        }),
        /*
         * `parseJsonField` returns `undefined` for an empty or unparseable
         * string, so those three keys are omitted rather than passed — the
         * same reason as every field above, arriving through a helper instead
         * of through `??`. They are the sites a grep for `?? undefined` does
         * not find, which is worth knowing before trusting a count of them.
         */
        ...(full_description ||
        house_rules ||
        cancellation_policy ||
        additional_info ||
        faq ||
        accessibility_info ||
        covid_guidelines
          ? {
              details: {
                upsert: {
                  create: {
                    full_description: full_description || event.description,
                    house_rules,
                    cancellation_policy,
                    ...(parseJsonField(additional_info) !== undefined && {
                      additional_info: parseJsonField(additional_info),
                    }),
                    ...(parseJsonField(faq) !== undefined && { faq: parseJsonField(faq) }),
                    ...(parseJsonField(accessibility_info) !== undefined && {
                      accessibility_info: parseJsonField(accessibility_info),
                    }),
                    covid_guidelines,
                  },
                  update: {
                    ...(full_description != null && { full_description }),
                    ...(house_rules != null && { house_rules }),
                    ...(cancellation_policy != null && { cancellation_policy }),
                    ...(parseJsonField(additional_info) !== undefined && {
                      additional_info: parseJsonField(additional_info),
                    }),
                    ...(parseJsonField(faq) !== undefined && { faq: parseJsonField(faq) }),
                    ...(parseJsonField(accessibility_info) !== undefined && {
                      accessibility_info: parseJsonField(accessibility_info),
                    }),
                    ...(covid_guidelines != null && { covid_guidelines }),
                  },
                },
              },
            }
          : {}),
        ...(Array.isArray(category_ids)
          ? {
              categories: {
                deleteMany: {},
                create: category_ids.map((categoryId: string, index: number) => ({
                  category: { connect: { id: categoryId } },
                  primary: categoryId === primary_category_id,
                  created_at: new Date(Date.now() + index),
                })),
              },
            }
          : {}),
        /*
         * `deleteMany` then recreate, exactly as categories do: the payload is
         * the full set the organiser ticked, so a diff would have to
         * distinguish "unticked" from "not sent" — and `undefined` already
         * means "not sent", which is what leaves an event's amenities alone.
         */
        ...(Array.isArray(amenity_ids)
          ? {
              amenities: {
                deleteMany: {},
                create: amenity_ids.map((amenityId: string) => ({
                  amenity: { connect: { id: amenityId } },
                })),
              },
            }
          : {}),
        ...(Array.isArray(media_items)
          ? {
              media: {
                deleteMany: {},
                create: media_items.map((item: Record<string, unknown>, index: number) => ({
                  type: item.type as "image" | "video" | "document",
                  url: item.url as string,
                  /*
                   * `|| undefined` here, not `!= null`: these arrive as
                   * unvalidated strings off the request body, and an empty one
                   * should leave the column at its default rather than write
                   * "". That is a different question from the fields above,
                   * where `""` was a value worth writing.
                   */
                  ...((item.thumbnail_url as string) && {
                    thumbnail_url: item.thumbnail_url as string,
                  }),
                  ...((item.title as string) && { title: item.title as string }),
                  ...((item.description as string) && {
                    description: item.description as string,
                  }),
                  order: typeof item.order === "number" ? item.order : index,
                })),
              },
            }
          : {}),
      },
    })

    // Reconcile the days whenever the schedule moves. Idempotent — a day that
    // survives the change keeps its id, and therefore its check-ins.
    if (start_time !== undefined || end_time !== undefined || timezone !== undefined) {
      await syncOccurrences(
        updatedEvent.id,
        updatedEvent.start_time,
        updatedEvent.end_time,
        updatedEvent.timezone
      )
    }

    // Fix #35, now shared with the mobile PATCH route, which cancelled events
    // without cascading. See lib/event-cancellation.ts.
    if (isCancelling) {
      await cancelEventCheckIns(resolvedParams.id)
    }

    // Tell the people who were going.
    //
    // Both of these were written, correct, and called by nobody — an event could
    // be cancelled or moved to a different venue and the only people who found
    // out were the ones who happened to reopen the app. Awaited but never thrown:
    // the write above has already committed, so a push failure must not turn a
    // successful edit into a 500.
    if (isCancelling) {
      await notifyEventCancelled(updatedEvent.id, updatedEvent.title)
    } else {
      await notifyEventDetailsChanged(
        updatedEvent.id,
        updatedEvent.title,
        materialEventChanges(event, updatedEvent)
      )
    }

    return NextResponse.json(updatedEvent)
  } catch (error) {
    logger.error("Error updating event", { error: error instanceof Error ? error.message : String(error) })
    return new NextResponse("Internal error", { status: 500 })
  }
}

export async function DELETE(_: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()

    if (!session?.user) {
      return new NextResponse("Unauthorized", { status: 401 })
    }

    const resolvedParams = await params
    const event = await db.events.findFirst({
      where: {
        id: resolvedParams.id,
        deleted_at: null,
      },
      // eventPermissions needs the venue owner: an event at a claimed venue
      // grants that owner operational access even though they cannot edit it.
      include: { venue: { select: { owner_org_id: true } } },
    })

    if (!event) {
      return new NextResponse("Event not found", { status: 404 })
    }

    if (!eventPermissions(await actorFor(session.user), event).canEdit) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    await db.events.update({
      where: { id: resolvedParams.id },
      data: {
        deleted_at: new Date(),
      },
    })

    auditLog({
      userId: session.user.id,
      action: "delete",
      resource: "event",
      resourceId: resolvedParams.id,
      details: { title: event.title },
    })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error("Error deleting event", { error: error instanceof Error ? error.message : String(error) })
    return new NextResponse("Internal error", { status: 500 })
  }
}
