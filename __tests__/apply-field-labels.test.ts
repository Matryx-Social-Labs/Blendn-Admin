import { readFileSync } from "fs"
import { join } from "path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { Field } from "@/app/apply/field"
import { Input } from "@/components/ui/input"

/*
 * Every /apply field is named by its caption, not its placeholder (SCRUM-183).
 *
 * Driven on staging: the nine `<label>`s had no `for` and the inputs no id, so
 * a screen reader read "Byg Brewski Brewing Company, edit text" for the name
 * field, and Address and Full name had no name at all.
 */
const field = (props: { label: string; required?: boolean; hint?: string }) =>
  createElement(Field, props, createElement(Input, { placeholder: "Byg Brewski Brewing Company" }))
const render = (props: { label: string; required?: boolean; hint?: string }) => renderToStaticMarkup(field(props))

it("ties the caption to the field it names", () => {
  const html = render({ label: "Name people will see", required: true })
  const labelFor = html.match(/<label[^>]*for="([^"]+)"/)?.[1]
  const inputId = html.match(/<input[^>]*id="([^"]+)"/)?.[1]

  expect(labelFor).toBeTruthy()
  expect(inputId).toBe(labelFor)
})

it("points the field at its hint, so the hint is read with it", () => {
  const html = render({ label: "Registered legal name", hint: "Leave blank if you operate as an individual." })
  const describedBy = html.match(/<input[^>]*aria-describedby="([^"]+)"/)?.[1]
  const hintId = html.match(/<p[^>]*id="([^"]+)"[^>]*>Leave blank/)?.[1]

  expect(describedBy).toBeTruthy()
  expect(describedBy).toBe(hintId)
})

it("gives two fields on one page different ids", () => {
  // One tree, as on the page: ids come from the tree, not from each call.
  const html = renderToStaticMarkup(createElement("div", null, field({ label: "City" }), field({ label: "Website" })))
  const ids = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map((m) => m[1])

  expect(new Set(ids).size).toBe(2)
})

it("leaves /apply with no field outside the labelled wrapper", () => {
  // The page keeps no second, unlabelled copy of the helper.
  const src = readFileSync(join(process.cwd(), "app/apply/page.tsx"), "utf8")
  expect(src).not.toMatch(/function Field\(/)
  expect(src).toMatch(/from "\.\/field"/)
})
