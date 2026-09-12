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
import { FormSection } from "@/components/event-form/form-section"
import { TimezoneSelect } from "@/components/event-form/timezone-select"
import type { EventFormValues } from "@/components/event-form/schema"

export function ScheduleSection({
  form,
}: {
  form: UseFormReturn<EventFormValues>
}) {
  return (
    <FormSection step="02" title="When" id="step-when">
      <div className="grid gap-4 @2xl/main:grid-cols-[1fr_1fr_minmax(0,1.2fr)]">
        <FormField
          control={form.control}
          name="start_time"
          render={({ field }) => (
            <FormItem id="field-start_time" className="scroll-mt-6">
              <FormLabel>Starts</FormLabel>
              <FormControl>
                <Input type="datetime-local" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="end_time"
          render={({ field }) => (
            <FormItem id="field-end_time" className="scroll-mt-6">
              <FormLabel>Ends</FormLabel>
              <FormControl>
                <Input type="datetime-local" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="timezone"
          render={({ field }) => (
            <FormItem id="field-timezone" className="scroll-mt-6">
              <FormLabel>
                Timezone{" "}
                <span className="font-normal text-muted-foreground">· where it happens</span>
              </FormLabel>
              <FormControl>
                <TimezoneSelect value={field.value} onChange={field.onChange} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </FormSection>
  )
}
