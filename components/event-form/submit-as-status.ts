import type { UseFormReturn } from "react-hook-form"

import type { EventFormValues } from "@/components/event-form/schema"

/**
 * Set the status a rail button asks for, then submit. A save that did not land
 * — the server refused it, the session ended, the form did not validate — puts
 * the status the event had back.
 *
 * The rail reads its buttons from that field. Left holding the refused status,
 * a draft whose Publish was refused (Razorpay's review organisation, every
 * time) read as published: the rail offered "Save changes", which sent
 * `published` again, and the editor was stuck until a reload (review of #760).
 */
export function submitAsStatus(
  form: Pick<UseFormReturn<EventFormValues>, "getValues" | "setValue" | "handleSubmit">,
  status: EventFormValues["status"],
  save: (data: EventFormValues) => Promise<boolean>
): Promise<void> {
  const before = form.getValues("status")
  form.setValue("status", status, { shouldDirty: true })
  const restore = () => form.setValue("status", before)
  return form.handleSubmit(async (data) => {
    if (!(await save(data))) restore()
  }, restore)()
}
