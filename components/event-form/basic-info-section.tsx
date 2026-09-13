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
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { IconPlus, IconX } from "@tabler/icons-react"
import { FormSection } from "@/components/event-form/form-section"
import { CoverImageSection } from "@/components/event-form/cover-image-section"
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
 * never orphaned. A child whose parent relation is gone — reparented or merged
 * by an admin while somebody has this form open — is grouped under its OWN
 * name rather than disappearing. (This used to say "falls into Other"; there
 * is no Other, and there never was.)
 */
export function groupByParent(categories: CategoryOption[], filter: string) {
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
  cover,
}: {
  form: UseFormReturn<EventFormValues>
  categories: CategoryOption[]
  cover: React.ComponentProps<typeof CoverImageSection>
}) {
  const [filter, setFilter] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)
  const visibleGroups = useMemo(() => groupByParent(categories, filter), [categories, filter])
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  return (
    <FormSection step="01" title="What is it" hint="the four things the card shows" id="step-what">
      <FormField
        control={form.control}
        name="title"
        render={({ field }) => (
          <FormItem id="field-title" className="scroll-mt-6">
            <FormLabel>Title</FormLabel>
            <FormControl>
              <Input placeholder="Sunset Sessions at The Humming Tree" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {/*
        The card's line, first, because the card is what most people will see.
        `description` is the body on the event page; `full_description` has no
        reader in the app and lives under More.
      */}
      <FormField
        control={form.control}
        name="short_description"
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              One line for the card{" "}
              <span className="font-normal text-muted-foreground">· optional</span>
            </FormLabel>
            <FormControl>
              <Input placeholder="Live indie on the terrace, doors at six" {...field} value={field.value ?? ""} />
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
            <FormLabel>Description</FormLabel>
            <FormControl>
              <Textarea placeholder="What happens, who it is for, what to bring." rows={4} {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="category_ids"
        render={({ field }) => {
          const chosen = (field.value ?? []).map((id) => byId.get(id)).filter(Boolean) as CategoryOption[]
          const primary = form.watch("primary_category_id")
          const remove = (id: string) => {
            const updated = (field.value ?? []).filter((x) => x !== id)
            if (form.getValues("primary_category_id") === id) {
              form.setValue("primary_category_id", updated[0])
            }
            field.onChange(updated)
          }
          const add = (id: string) => {
            if (field.value?.includes(id)) return
            field.onChange([...(field.value ?? []), id])
            if (!form.getValues("primary_category_id")) form.setValue("primary_category_id", id)
          }
          return (
            <FormItem id="field-category_ids" className="scroll-mt-6">
              <FormLabel>Categories</FormLabel>
              {/*
                Chosen ones as chips; the taxonomy behind a picker.

                Every category as a wall of checkboxes — 89 of them, grouped
                under 15 headings — was roughly a thousand pixels between the
                description and the cover, on every visit, for a choice most
                events make once. The first chip is the primary category, which
                is what the card shows; click another chip to make it primary.
              */}
              <div className="flex flex-wrap items-center gap-1.5">
                {chosen.map((cat) => {
                  const isPrimary = cat.id === primary
                  return (
                    <span
                      key={cat.id}
                      className={
                        "inline-flex h-7 items-center gap-1 rounded-full pl-2.5 pr-1 text-[0.75rem] font-medium " +
                        (isPrimary ? "bg-primary/15 text-foreground ring-1 ring-primary/40" : "bg-secondary")
                      }
                    >
                      <button
                        type="button"
                        onClick={() => form.setValue("primary_category_id", cat.id)}
                        aria-pressed={isPrimary}
                        aria-label={isPrimary ? `${cat.name}, primary category` : `Make ${cat.name} the primary category`}
                        className="rounded-full"
                      >
                        {cat.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(cat.id)}
                        aria-label={`Remove ${cat.name}`}
                        className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <IconX className="size-3" aria-hidden />
                      </button>
                    </span>
                  )
                })}
                <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="outline" size="sm" className="h-7 rounded-full border-dashed px-2.5 text-[0.75rem]">
                      <IconPlus className="size-3.5" aria-hidden />
                      Add
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-80 p-0">
                    <div className="border-b border-border p-2">
                      <Input
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Search categories"
                        aria-label="Filter categories"
                        className="h-8"
                        autoFocus
                      />
                    </div>
                    <div className="max-h-72 overflow-y-auto p-2">
                      {categories.length === 0 ? (
                        <p className="p-2 text-sm text-muted-foreground">No categories available.</p>
                      ) : null}
                      {visibleGroups.length === 0 && categories.length > 0 ? (
                        <p className="p-2 text-sm text-muted-foreground">Nothing matches &ldquo;{filter}&rdquo;.</p>
                      ) : null}
                      {visibleGroups.map((group) => (
                        <fieldset key={group.key} className="mb-2">
                          <legend className="px-2 pb-1 text-[0.7rem] font-medium uppercase tracking-[0.06em] text-faint-foreground">
                            {group.label}
                          </legend>
                          {group.items.map((cat) => {
                            const checked = field.value?.includes(cat.id) ?? false
                            return (
                              <label
                                key={cat.id}
                                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
                              >
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(v) => (v ? add(cat.id) : remove(cat.id))}
                                />
                                {cat.name}
                              </label>
                            )
                          })}
                        </fieldset>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
              <FormMessage />
            </FormItem>
          )
        }}
      />

      <div id="field-cover" className="scroll-mt-6">
        <CoverImageSection {...cover} />
      </div>
    </FormSection>
  )
}
