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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { FormSection } from "@/components/event-form/form-section"
import type { EventFormValues } from "@/components/event-form/schema"

export function CapacitySettingsSection({
  form,
  canFeature,
}: {
  form: UseFormReturn<EventFormValues>
  /** Only app_admin may put an event on the platform's featured rail. */
  canFeature: boolean
}) {
  return (
    <FormSection step="04" title="Who can come" id="step-who">
      {/*
        No Status select. Publishing is a gated transition and lives on the
        rail's buttons; cancelling is its own action there. "Completed" had no
        writer and no meaning — `eventStateFor` derives "over" from `end_time`.
      */}
      <div className="grid gap-4 @2xl/main:grid-cols-[1.1fr_1.3fr_0.8fr_0.8fr]">
        <FormField
          control={form.control}
          name="visibility"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Visibility</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Public" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="public">Public</SelectItem>
                  <SelectItem value="unlisted">Unlisted</SelectItem>
                  <SelectItem value="private">Private</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="door_policy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Door</FormLabel>
              <Select onValueChange={field.onChange} value={field.value ?? "open"}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Anyone can turn up" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="open">Anyone can turn up</SelectItem>
                  <SelectItem value="guest_list">Guest list only</SelectItem>
                  <SelectItem value="members_only">Members only</SelectItem>
                  <SelectItem value="invite_only">Invite only</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="min_age"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Minimum age</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={13}
                  max={25}
                  placeholder="None"
                  value={field.value ?? ""}
                  onChange={(e) =>
                    field.onChange(e.target.value === "" ? undefined : Number(e.target.value))
                  }
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="max_capacity"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Capacity</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  placeholder="Unlimited"
                  value={field.value ?? ""}
                  onChange={(e) =>
                    field.onChange(e.target.value === "" ? undefined : Number(e.target.value))
                  }
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      {/*
        The two rules a reader cannot infer, and only those. Door policy is a
        badge Blend'n does not enforce; the minimum age IS enforced — discovery
        hides the event and check-in refuses — so an organiser setting it needs
        to know it turns people away rather than warning them.
      */}
      <p className="text-[0.8125rem] text-muted-foreground">
        The door policy is shown as a badge; your door enforces it. A minimum age
        hides the event from anyone younger, or who has not told us their age.
      </p>

      <div className="grid gap-4 @2xl/main:grid-cols-2">
        <FormField
          control={form.control}
          name="external_link"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Tickets link <span className="font-normal text-muted-foreground">· optional</span>
              </FormLabel>
              <FormControl>
                <Input placeholder="https://" {...field} value={field.value ?? ""} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {canFeature ? (
          <FormField
            control={form.control}
            name="is_featured"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between gap-4 @2xl/main:pt-6">
                <div className="space-y-0.5">
                  <FormLabel>Featured</FormLabel>
                  <div className="text-[0.8125rem] text-muted-foreground">
                    On the Pulse&rsquo;s featured rail. Admins only.
                  </div>
                </div>
                <FormControl>
                  <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
        ) : null}
      </div>
    </FormSection>
  )
}
