"use client"

import type { UseFieldArrayReturn, UseFormReturn } from "react-hook-form"
import { Button } from "@/components/ui/button"
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { IconPlus, IconTrash } from "@tabler/icons-react"
import { FormSection } from "@/components/event-form/form-section"
import type { EventFormValues } from "@/components/event-form/schema"

export function AdvancedSection({
  form,
  faqFieldArray,
  additionalInfoFieldArray,
  accessibilityInfoFieldArray,
}: {
  form: UseFormReturn<EventFormValues>
  faqFieldArray: UseFieldArrayReturn<EventFormValues, "faq">
  additionalInfoFieldArray: UseFieldArrayReturn<EventFormValues, "additional_info">
  accessibilityInfoFieldArray: UseFieldArrayReturn<EventFormValues, "accessibility_info">
}) {
  return (
    <FormSection title="Details" level={3}>
      {/*
        Required and first on the old form, as "Full Description *". No app
        screen renders `fullDescription` — the API falls back to `description`
        and 4 of 31 staging events differ — so it is optional and last.
      */}
      <FormField
        control={form.control}
        name="full_description"
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              Long description{" "}
              <span className="font-normal text-muted-foreground">· optional, not shown in the app yet</span>
            </FormLabel>
            <FormControl>
              <Textarea rows={5} {...field} value={field.value ?? ""} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <div className="grid gap-4 @2xl/main:grid-cols-2">
        <FormField
          control={form.control}
          name="house_rules"
          render={({ field }) => (
            <FormItem>
              <FormLabel>House Rules</FormLabel>
              <FormControl>
                <Textarea placeholder="Rules for attendees" rows={3} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="cancellation_policy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Cancellation Policy</FormLabel>
              <FormControl>
                <Textarea placeholder="Cancellation policy" rows={3} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      {/* FAQ */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <FormLabel>FAQ</FormLabel>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => faqFieldArray.append({ question: "", answer: "" })}
          >
            <IconPlus className="size-4 mr-1" />
            Add Q&A
          </Button>
        </div>
        {faqFieldArray.fields.map((item, index) => (
          <div key={item.id} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Q&A #{index + 1}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => faqFieldArray.remove(index)}
              >
                <IconTrash className="size-4" />
              </Button>
            </div>
            <FormField
              control={form.control}
              name={`faq.${index}.question`}
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input placeholder="Question" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name={`faq.${index}.answer`}
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Textarea placeholder="Answer" rows={2} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        ))}
      </div>

      {/* Accessibility Info */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <FormLabel>Accessibility Info</FormLabel>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              accessibilityInfoFieldArray.append({ key: "", value: "" })
            }
          >
            <IconPlus className="size-4 mr-1" />
            Add
          </Button>
        </div>
        {accessibilityInfoFieldArray.fields.map((item, index) => (
          <div key={item.id} className="flex items-center gap-2">
            <FormField
              control={form.control}
              name={`accessibility_info.${index}.key`}
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormControl>
                    <Input placeholder="e.g. Wheelchair access" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name={`accessibility_info.${index}.value`}
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormControl>
                    <Input placeholder="Yes / details" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => accessibilityInfoFieldArray.remove(index)}
            >
              <IconTrash className="size-4" />
            </Button>
          </div>
        ))}
      </div>

      {/* Additional Info */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <FormLabel>Additional Info</FormLabel>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              additionalInfoFieldArray.append({ key: "", value: "" })
            }
          >
            <IconPlus className="size-4 mr-1" />
            Add
          </Button>
        </div>
        {additionalInfoFieldArray.fields.map((item, index) => (
          <div key={item.id} className="flex items-center gap-2">
            <FormField
              control={form.control}
              name={`additional_info.${index}.key`}
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormControl>
                    <Input placeholder="Key" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name={`additional_info.${index}.value`}
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormControl>
                    <Input placeholder="Value" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => additionalInfoFieldArray.remove(index)}
            >
              <IconTrash className="size-4" />
            </Button>
          </div>
        ))}
      </div>
    </FormSection>
  )
}
