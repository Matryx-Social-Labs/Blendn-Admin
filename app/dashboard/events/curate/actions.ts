"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { curatedDescription, curatedFence } from "@/lib/curation"
import { sourceDomain } from "@/lib/curation-sources"
import { db } from "@/lib/db"
import { uniqueEventSlug } from "@/lib/event-slug"
import { canPublish } from "@/lib/geofence-input"
import { logger } from "@/lib/logger"

/**
 * Add an event the platform found, so a city with no supply has something in it.
 *
 * ## What is deliberately not copied
 *
 * No cover image and no description from the source. Decision 2 forbids
 * reproducing a listing's prose or images, and the reason is not only legal: a
 * description lifted from somewhere else reads as somebody else's, and the
 * honest line — *we found this, go and check the source* — is what keeps the
 * platform trustworthy when a detail turns out to be wrong. It will.
 *
 * The description is generated from the facts we did enter, by
 * `curatedDescription`, which is a pure function so the rule is testable.
 *
 * ## `source_url` is set here and nowhere else
 *
 * It is absent from `eventWriteSchema`, so no edit path can reach it. That is
 * the point: a claimant whose claim is verified partly by matching their domain
 * against this URL must not be able to move it. `external_link` is the one an
 * owner may edit.
 */
const curateSchema = z.object({
  title: z.string().trim().min(3).max(200),
  /** Where it is, as the admin confirmed it on the map. */
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  venue_name: z.string().trim().min(1).max(200).nullable(),
  address: z.string().trim().max(500).nullable(),
  city: z.string().trim().min(1).max(120),
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  timezone: z.string().trim().min(1).max(60),
  /** The public listing. Recorded, never rendered as prose. */
  source_url: z.string().url().max(2000),
  max_capacity: z.number().int().positive().max(100_000).nullable().optional(),
  min_age: z.number().int().min(0).max(99).nullable().optional(),
  category_ids: z.array(z.string().uuid()).max(5).optional(),
})

export type CurateInput = z.infer<typeof curateSchema>

export async function curateEvent(
  input: CurateInput
): Promise<{ ok: true; eventId: string; slug: string } | { ok: false; error: string }> {
  const session = await getAuth()
  /*
   * Founders run curation. Not `canAccessDashboard`: an organiser adding events
   * "on behalf of" somebody else is exactly the confusion the claim funnel
   * exists to resolve, and it would let them mint an event another organiser
   * could then be offered.
   */
  if (session?.user?.role !== "app_admin") {
    return { ok: false, error: "Only platform admins can curate events" }
  }

  const parsed = curateSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }
  }
  const v = parsed.data

  const start = new Date(v.start_time)
  const end = new Date(v.end_time)
  if (end <= start) return { ok: false, error: "The event must end after it starts" }

  /*
   * A curated event is published immediately — an unpublished one is invisible,
   * and invisible is the state the city is already in. So the publish gate
   * applies at creation rather than at a later transition.
   *
   * `canPublish` had no caller outside its own test until #268. This is the
   * path it was written for: a curated pin is the most likely of all pins to be
   * missing, because nobody stood there.
   */
  const geofence = curatedFence(v.latitude, v.longitude)
  const gate = canPublish({ latitude: v.latitude, longitude: v.longitude, geofence })
  if (!gate.ok) return { ok: false, error: gate.reason ?? "Cannot publish" }

  try {
    const event = await db.events.create({
      data: {
        title: v.title,
        slug: await uniqueEventSlug(v.title),
        // Generated from facts. Never the listing's own words. See the header.
        description: curatedDescription({
          title: v.title,
          venueName: v.venue_name,
          city: v.city,
        }),
        venue_name: v.venue_name,
        address: v.address,
        city: v.city,
        start_time: start,
        end_time: end,
        timezone: v.timezone,
        status: "published",
        visibility: "public",
        max_capacity: v.max_capacity ?? null,
        min_age: v.min_age ?? null,
        latitude: v.latitude,
        longitude: v.longitude,
        geofence,
        check_in_radius: geofence.radius,
        /*
         * The curation marks. `curated_at` is what makes this claimable and is
         * the only thing separating it from a legacy row with no owner —
         * measured at 18 of 28 events in production, none of them curated.
         */
        curated_at: new Date(),
        source_url: v.source_url,
        /*
         * Who created the row, which is an audit question. Ownership stays null:
         * `eventPermissions` short-circuits app_admin, so the platform can
         * operate it, and a claim fills it in with one write.
         */
        organizer_id: session.user.id,
        organizer_org_id: null,
        ...(v.category_ids?.length
          ? { categories: { create: v.category_ids.map((id) => ({ category_id: id })) } }
          : {}),
      },
      select: { id: true, slug: true },
    })

    auditLog({
      userId: session.user.id,
      action: "event.curated",
      resource: "event",
      resourceId: event.id,
      // The source domain, not the whole URL: enough to answer "where are we
      // curating from" without putting a query string in the audit trail.
      details: { title: v.title, city: v.city, source: sourceDomain(v.source_url) },
    })

    revalidatePath("/dashboard/events")
    return { ok: true, eventId: event.id, slug: event.slug }
  } catch (error) {
    logger.error("Curate event failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return { ok: false, error: "Could not add the event" }
  }
}
