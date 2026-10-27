/**
 * A rail button sets the status and submits; a save that did not land puts the
 * event's status back (components/event-form/submit-as-status.ts). Driven with
 * a form double that keeps one field and runs the same callbacks
 * react-hook-form's handleSubmit does.
 */
import type { EventFormValues } from "@/components/event-form/schema"
import { submitAsStatus } from "@/components/event-form/submit-as-status"

type Status = EventFormValues["status"]

function formAt(status: Status, valid = true) {
  let value = status
  const sent: Status[] = []
  const form = {
    getValues: () => value,
    setValue: (_name: "status", next: Status) => {
      value = next
    },
    handleSubmit: (onValid: (data: EventFormValues) => Promise<void>, onInvalid?: () => void) => async () => {
      if (!valid) return onInvalid?.()
      sent.push(value)
      await onValid({ status: value } as EventFormValues)
    },
  }
  return { form: form as never, status: () => value, sent }
}

it("a refused Publish leaves the draft a draft, and Save as draft then goes through", async () => {
  const f = formAt("draft")
  const server = jest.fn(async (data: EventFormValues) => data.status !== "published") // 403 on publish
  await submitAsStatus(f.form, "published", server)
  expect(f.status()).toBe("draft")
  await submitAsStatus(f.form, "draft", server)
  expect(f.sent).toEqual(["published", "draft"])
  expect(f.status()).toBe("draft")
})

it("a save that lands keeps the status it sent", async () => {
  const f = formAt("draft")
  await submitAsStatus(f.form, "published", async () => true)
  expect(f.status()).toBe("published")
})

it("a form that does not validate puts the status back without sending", async () => {
  const f = formAt("draft", false)
  const server = jest.fn(async () => true)
  await submitAsStatus(f.form, "published", server)
  expect(server).not.toHaveBeenCalled()
  expect(f.status()).toBe("draft")
})

it("the editor tells the form whether the save landed: false on a refusal, an ended session or an error", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const src: string = require("fs").readFileSync(require("path").join(__dirname, "../components/event-editor.tsx"), "utf8")
  const handler = src.slice(src.indexOf("const handleSubmit = async"), src.indexOf("return (", src.indexOf("const handleSubmit = async")))
  expect(handler).toMatch(/Promise<boolean>/)
  // Each branch's own block, up to its closing brace: a later `return false` cannot stand in for it.
  expect(handler).toMatch(/if \(response\.status === 401\) \{[^}]*return false\s*\}/)
  expect(handler).toMatch(/if \(!response\.ok\) \{[^}]*return false\s*\}/)
  expect(handler).toMatch(/catch \(error\) \{[^}]*\}\)\s*toast\.error\("Failed to save event"\)\s*return false\s*\}/)
  expect(handler).not.toMatch(/return\s*\n/)
})
