"use client"

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

export function BasicInfoSection({
  form,
  categories,
}: {
  form: UseFormReturn<EventFormValues>
  categories: Array<{ id: string; name: string }>
}) {
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
              <div className="grid grid-cols-2 gap-2">
                {categories.length === 0 && (
                  <p className="text-muted-foreground text-sm">No categories available.</p>
                )}
                {categories.map((cat) => {
                  const checked = field.value?.includes(cat.id) ?? false
                  return (
                    <label
                      key={cat.id}
                      className="flex items-center gap-2 rounded-md border p-2 text-sm cursor-pointer hover:bg-muted/50"
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
