import { toast } from "sonner"

import type { EventFormValues } from "@/components/event-form/schema"
import { refusalMessage } from "@/lib/refusal"
import { createVenue } from "@/lib/venue-actions"
import type { venue_type } from "@prisma/client"

/**
 * A place picked from the map is saved as a venue when its event is saved
 * (SCRUM-353c) — unclaimed, recorded against the organiser's organisation — so
 * the next event there picks it from the list instead of drawing it again.
 *
 * With the area the event has now: the outline OSM gave, or the one adjusted.
 * Returns the venue's id to link, or null when there was nothing to save or it
 * was refused (no organisation, a listed venue ignored). The event saves either
 * way; a refusal is said, not swallowed.
 */
export async function saveAsVenue(values: EventFormValues): Promise<string | null> {
  const place = values.new_venue
  const name = values.venue_name?.trim()
  if (!place || values.venue_id || !name || values.latitude == null || values.longitude == null) return null
  try {
    const { id } = await createVenue({
      name,
      venueType: place.venue_type as venue_type | null,
      address: values.address,
      city: values.city,
      lat: values.latitude,
      lng: values.longitude,
      geofence: values.geofence ?? undefined,
      acknowledgedDuplicates: place.acknowledged_duplicates,
      asUnclaimed: true,
    })
    toast.success(`${name} is listed now — the next event there picks it instead of drawing it.`)
    return id
  } catch (e) {
    toast.warning(`The event saves, but ${name} was not listed: ${refusalMessage(e, "the venue could not be saved.")}`)
    return null
  }
}
