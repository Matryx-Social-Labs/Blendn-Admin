"use client"

import type { UseFormReturn } from "react-hook-form"

import { Checkbox } from "@/components/ui/checkbox"
import { FormField, FormItem, FormMessage } from "@/components/ui/form"
import { FormSection } from "@/components/event-form/form-section"
import type { EventFormValues } from "@/components/event-form/schema"

export interface AmenityOption {
  id: string
  name: string
  subtitle?: string | null
}

/**
 * What this event offers — the amenity tiles on The Scene.
 *
 * ## A vocabulary, not a text box
 *
 * `events.house_rules` already exists and is free text. It is a different
 * thing: "open bar (from 9)" typed by one organiser and "Free drinks!!" by
 * another are two facts nothing can group, render as an icon, or translate.
 * These come from a seeded list, the same shape as categories.
 *
 * ## Ticked by the organiser, not inherited from the venue
 *
 * `docs/AMENITIES.md` plans a venue layer that pre-ticks this from the venue's
 * own list. It is deliberately not built: an **unowned** venue has no list to
 * suggest from, and almost no venue is owned today, so it would be a
 * permission system and a picker that did nothing. When ownership is dense
 * enough, suggestions land here as defaults — and the event still stores its
 * own rows, so a venue editing its list next month cannot change what last
 * month's event claimed.
 *
 * ## Nothing is ticked by default
 *
 * An event with no amenities draws no tiles, which is the honest state. The
 * alternative is every event claiming an open bar because a default said so,
 * and this section is the organiser asserting facts attendees will turn up
 * expecting.
 */
export function AmenitiesSection({
  form,
  amenities,
}: {
  form: UseFormReturn<EventFormValues>
  amenities: AmenityOption[]
}) {
  return (
    <FormSection title="What's included" level={3}>
      <p className="text-sm text-muted-foreground">
        Shown as tiles on the event page. Tick only what you are actually
        providing — people will arrive expecting these.
      </p>

      <FormField
        control={form.control}
        name="amenity_ids"
        render={({ field }) => (
          <FormItem>
            <div className="grid grid-cols-2 gap-2">
              {amenities.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  No amenities available.
                </p>
              )}
              {amenities.map((a) => {
                const checked = field.value?.includes(a.id) ?? false
                return (
                  <label
                    key={a.id}
                    className="flex items-start gap-2 rounded-md border p-2 text-sm cursor-pointer hover:bg-muted/50"
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={checked}
                      onCheckedChange={(v) => {
                        const next = field.value ? [...field.value] : []
                        // Filter on untick rather than splice: `next` is a copy
                        // and an index lookup here would go stale the moment
                        // the list is reordered by a seed change.
                        field.onChange(
                          v ? [...next, a.id] : next.filter((id) => id !== a.id)
                        )
                      }}
                      aria-label={a.name}
                    />
                    <span>
                      <span className="block">{a.name}</span>
                      {a.subtitle && (
                        <span className="block text-xs text-muted-foreground">
                          {a.subtitle}
                        </span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
            <FormMessage />
          </FormItem>
        )}
      />
    </FormSection>
  )
}
