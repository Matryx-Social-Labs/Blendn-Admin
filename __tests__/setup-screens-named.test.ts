import { readFileSync } from "fs"
import { join } from "path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

jest.mock("@/lib/amenity-actions", () => ({ createAmenity: jest.fn(), setAmenityActive: jest.fn(), updateAmenity: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { AmenityManager } from "@/app/dashboard/amenities/manager"

/*
 * The Setup screens name every control for a screen reader (SCRUM-469).
 *
 * Read from the accessibility tree on staging: both rename boxes had no name,
 * the new category's Name was named by its placeholder, and all fifteen amenity
 * rows said just "Rename" and "Retire". Categories already named their row
 * buttons; amenities now match.
 */
const ROOT = join(__dirname, "..")
const source = (p: string) => readFileSync(join(ROOT, p), "utf8")

it("names each amenity row's buttons after the amenity", () => {
  const html = renderToStaticMarkup(
    createElement(AmenityManager, {
      amenities: [
        { id: "a1", name: "Open Bar", subtitle: null, icon: null, isActive: true, eventCount: 2 },
        { id: "a2", name: "Cloakroom", subtitle: null, icon: null, isActive: false, eventCount: 0 },
      ] as never,
    })
  )
  expect(html).toContain('aria-label="Rename Open Bar"')
  expect(html).toContain('aria-label="Retire Open Bar"')
  expect(html).toContain('aria-label="Restore Cloakroom"')
})

it("names both rename boxes, and ties the new category's captions to their fields", () => {
  // The rename boxes exist only while editing, which a static render cannot reach.
  expect(source("app/dashboard/categories/manager.tsx")).toMatch(/aria-label=\{`New name for \$\{row\.name\}`\}/)
  expect(source("app/dashboard/amenities/manager.tsx")).toMatch(/aria-label=\{`New name for \$\{amenity\.name\}`\}/)

  const create = source("app/dashboard/categories/manager.tsx")
  expect(create).toMatch(/<label htmlFor=\{nameId\}/)
  expect(create).toMatch(/<Input id=\{nameId\}/)
  expect(create).toMatch(/<label htmlFor=\{parentId\}|<label htmlFor=\{parentFieldId\}/)
})
