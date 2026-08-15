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
  isEditing,
}: {
  form: UseFormReturn<EventFormValues>
  isEditing: boolean
}) {
  return (
    <FormSection title="Capacity & Settings">
      {isEditing && (
        <FormField
          control={form.control}
          name="status"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Status</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="visibility"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Visibility</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select visibility" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="public">Public</SelectItem>
                  <SelectItem value="private">Private</SelectItem>
                  <SelectItem value="unlisted">Unlisted</SelectItem>
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
              <FormLabel>Door policy</FormLabel>
              <Select onValueChange={field.onChange} value={field.value ?? "open"}>
                <FormControl>
                  <SelectTrigger>
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
              <p className="text-xs text-muted-foreground">
                Shown on your event as a badge, so people know what to expect at
                the door. <strong>Blendn does not enforce this</strong> — it
                does not stop anyone joining or checking in, exactly like the
                minimum age. Your door does.
                <br />
                Leave it as &ldquo;anyone can turn up&rdquo; and we show how many
                places are left instead, once the event is nearly full.
              </p>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="max_capacity"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Max Capacity</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  placeholder="Unlimited if blank"
                  value={field.value ?? ""}
                  onChange={(e) =>
                    field.onChange(
                      e.target.value === "" ? undefined : Number(e.target.value)
                    )
                  }
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

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
                placeholder="No age restriction"
                value={field.value ?? ""}
                onChange={(e) =>
                  field.onChange(e.target.value === "" ? undefined : Number(e.target.value))
                }
              />
            </FormControl>
            <div className="text-muted-foreground text-sm">
              {/*
                Said plainly because it is a real refusal at the door, not a
                label on a listing — an organiser setting this needs to know it
                turns people away rather than warning them.
              */}
              Leave blank unless the event has one. Anyone below this age cannot
              check in, and the event is hidden from them. Attendees who have not
              given us an age are refused too.
            </div>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="is_featured"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <FormLabel>Featured</FormLabel>
                <div className="text-muted-foreground text-sm">
                  Highlight this event on the home screen.
                </div>
              </div>
              <FormControl>
                <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="external_link"
          render={({ field }) => (
            <FormItem>
              <FormLabel>External Link</FormLabel>
              <FormControl>
                <Input placeholder="https://…" {...field} value={field.value ?? ""} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </FormSection>
  )
}
