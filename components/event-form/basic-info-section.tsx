"use client"

import { useMemo, useState } from "react"
import type { UseFormReturn } from "react-hook-form"
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { FormSection } from "@/components/event-form/form-section"
import type { EventFormValues } from "@/components/event-form/schema"

/**
 * One selectable category, with the parent it hangs off.
 *
 * `parent` is null for the fourteen top-level ones, which are selectable in
 * their own right — an event really can be "Music" without being any
 * particular kind of music night.
 */
export interface CategoryOption {
  id: string
  name: string
  parent_id: string | null
  parent: { name: string } | null
}

/**
 * Children under their parent, parents first, in taxonomy order.
 *
 * A top-level category with no children of its own still gets a group so it is
 * never orphaned, and anything whose parent is missing from the list falls into
 * "Other" rather than disappearing — a category can be reparented or merged by
 * an admin while somebody has this form open.
 */
function groupByParent(categories: CategoryOption[], filter: string) {
  const needle = filter.trim().toLowerCase()
  const groups = new Map<string, { key: string; label: string; items: CategoryOption[] }>()

  for (const cat of categories) {
    const key = cat.parent_id ?? cat.id
    const label = cat.parent?.name ?? cat.name
    // A parent name that matches keeps its whole group, so typing "sport"
    // leaves every screening under Sports rather than only the one called
    // "Sports".
    const matches =
      !needle || cat.name.toLowerCase().includes(needle) || label.toLowerCase().includes(needle)
    if (!matches) continue

    const group = groups.get(key) ?? { key, label, items: [] }
    group.label = label
    group.items.push(cat)
    groups.set(key, group)
  }

  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
}

export function BasicInfoSection({
  form,
  categories,
}: {
  form: UseFormReturn<EventFormValues>
  categories: CategoryOption[]
}) {
  const [filter, setFilter] = useState("")
  const visibleGroups = useMemo(() => groupByParent(categories, filter), [categories, filter])

  return (
    <FormSection title="Basic Info">
      <FormField
        control={form.control}
        name="title"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Title *</FormLabel>
            <FormControl>
              <Input placeholder="Event title" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="description"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Description *</FormLabel>
            <FormControl>
              <Textarea placeholder="Short event description (shown on cards)" rows={3} {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="full_description"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Full Description *</FormLabel>
            <FormControl>
              <Textarea placeholder="Detailed event information shown on the event page" rows={5} {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="short_description"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Short Description</FormLabel>
            <FormControl>
              <Input placeholder="One-line summary (optional)" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {/* Categories */}
      <FormField
        control={form.control}
        name="category_ids"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Categories</FormLabel>
            <div className="flex flex-col gap-3">
              {/*
                Grouped under the parent, and filterable.

                All 89 rendered as one alphabetised two-column wall of
                checkboxes — roughly a thousand pixels of them, with `Sports`
                and `IPL screening` as peers at opposite ends. The taxonomy is
                two levels on purpose (`scripts/seed-categories.ts`: "IPL,
                cricket, football and F1 draw different crowds on different
                nights") and `/dashboard/categories` has grouped them that way
                all along. This is the screen where it matters most: the
                organiser knows what kind of night they are running before they
                know what it is called here.

                The filter is not decoration at 89 options. It matches parent
                names too, so typing "sport" keeps the whole Sports group.
              */}
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter categories…"
                className="max-w-xs"
                aria-label="Filter categories"
              />
              {categories.length === 0 && (
                <p className="text-muted-foreground text-sm">No categories available.</p>
              )}
              {visibleGroups.length === 0 && categories.length > 0 && (
                <p className="text-muted-foreground text-sm">
                  Nothing matches &ldquo;{filter}&rdquo;.
                </p>
              )}
              <div className="flex flex-col gap-4">
                {visibleGroups.map((group) => (
                  <fieldset key={group.key} className="flex flex-col gap-2">
                    <legend className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-faint-foreground">
                      {group.label}
                    </legend>
                    <div className="grid grid-cols-2 gap-2">
                      {group.items.map((cat) => {
                        const checked = field.value?.includes(cat.id) ?? false
                        return (
                          <label
                            key={cat.id}
                            className="flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm hover:bg-muted/50"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(v) => {
                                const next = field.value ? [...field.value] : []
                                if (v) {
                                  next.push(cat.id)
                                  if (!form.getValues("primary_category_id")) {
                                    form.setValue("primary_category_id", cat.id)
                                  }
                                } else {
                                  const updated = next.filter((id) => id !== cat.id)
                                  if (form.getValues("primary_category_id") === cat.id) {
                                    form.setValue("primary_category_id", updated[0])
                                  }
                                  field.onChange(updated)
                                  return
                                }
                                field.onChange(next)
                              }}
                            />
                            {cat.name}
                          </label>
                        )
                      })}
                    </div>
                  </fieldset>
                ))}
              </div>

              {field.value && field.value.length > 0 && (
                <div className="space-y-1 rounded-md border p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    Select the primary category:
                  </p>
                  <RadioGroup
                    value={form.watch("primary_category_id")}
                    onValueChange={(v) => form.setValue("primary_category_id", v)}
                    className="gap-2"
                  >
                    {field.value.map((catId) => {
                      const cat = categories.find((c) => c.id === catId)
                      if (!cat) return null
                      return (
                        <label
                          key={catId}
                          className="flex items-center gap-2 text-sm cursor-pointer"
                        >
                          <RadioGroupItem value={catId} />
                          {cat.name}
                        </label>
                      )
                    })}
                  </RadioGroup>
                </div>
              )}
            </div>
            <FormMessage />
          </FormItem>
        )}
      />
    </FormSection>
  )
}
