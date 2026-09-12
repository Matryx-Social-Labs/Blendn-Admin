import { readFileSync } from "fs"
import { join } from "path"

import { renderableImageUrl, READINESS_ANCHORS } from "@/components/event-form/publish-rail"
import { eventReadiness } from "@/lib/event-readiness"

/**
 * The event authoring screen, redesigned around one question: can this
 * publish yet, and what is still missing.
 *
 * Before: a 6,384px single column of eight bordered collapsible sections, a
 * readiness strip at the very top and one "Create Event" button at the very
 * bottom — so the answer was visible from neither end of where the organiser
 * was typing; a Status dropdown that could set "completed" (no writer, no
 * meaning) and was the only way to cancel; "Full Description *" required for
 * a field no app screen renders; ~70 category checkboxes on every visit; and
 * a Featured switch any organiser could flip, which the API accepted.
 *
 * Now: four sections in question order and a sticky rail that holds the card
 * preview, the readiness list (each item a link to its field) and the
 * actions. Publish is disabled until the list is empty.
 */
const ROOT = join(__dirname, "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

const form = read("components/event-form.tsx")
const who = read("components/event-form/capacity-settings-section.tsx")
const what = read("components/event-form/basic-info-section.tsx")
const rail = read("components/event-form/publish-rail.tsx")

describe("the rail answers 'can this publish' from every scroll position", () => {
  it("the form renders the rail and, below @4xl/main, the bar — and no submit button of its own", () => {
    expect(form).toMatch(/<PublishRail \{\.\.\.railProps\} card=\{card\} \/>/)
    expect(form).toMatch(/<PublishBar \{\.\.\.railProps\} \/>/)
    expect(form).not.toMatch(/type="submit"/)
    // The native submit is disarmed: the buttons decide the status.
    expect(form).toMatch(/onSubmit=\{\(e\) => e\.preventDefault\(\)\}/)
  })

  it("the buttons set the status; there is no Status select anywhere on the form", () => {
    expect(form).toMatch(/onSaveDraft: \(\) => submitAs\("draft"\)/)
    expect(form).toMatch(/onPublish: \(\) => submitAs\("published"\)/)
    expect(who).not.toMatch(/name="status"/)
    expect(who).not.toMatch(/completed/)
  })

  it("Publish is disabled while anything blocks, and says how many things are left", () => {
    expect(rail).toMatch(/const blocked = readiness\.blockers\.length > 0/)
    expect(rail).toMatch(/disabled=\{isSubmitting \|\| blocked \|\| cancelled\}/)
    expect(rail).toMatch(/thing\$\{left === 1 \? "" : "s"\} left before it can publish/)
  })

  it("every readiness item links to its field, and every field id the links use exists on the form", () => {
    const sources = [what, read("components/event-form/schedule-section.tsx"), read("components/event-form/location-section.tsx")].join("\n")
    for (const anchor of Object.values(READINESS_ANCHORS)) {
      expect(sources).toMatch(new RegExp(`id="${anchor}"`))
    }
    // And the model tags every item with a field, so the map above is total.
    const empty = eventReadiness({})
    for (const item of [...empty.blockers, ...empty.warnings]) {
      expect(READINESS_ANCHORS[item.field]).toBeTruthy()
    }
  })

  it("the sticky rail is not defeated by the layout: the sidebar inset clips, it does not scroll", () => {
    // `overflow-hidden` makes the inset a scroll container, and a sticky
    // element sticks to the nearest one — the rail scrolled away with the page.
    const layout = read("app/dashboard/layout.tsx")
    expect(layout).toMatch(/<SidebarInset className="overflow-x-clip /)
    expect(layout).not.toMatch(/<SidebarInset className="overflow-hidden/)
  })
})

describe("the cuts", () => {
  it("the long description is optional, because no app screen renders it", () => {
    expect(read("components/event-form/schema.ts")).toMatch(/full_description: z\.string\(\)\.optional\(\)/)
    expect(what).not.toMatch(/name="full_description"/)
    expect(read("components/event-form/advanced-section.tsx")).toMatch(/name="full_description"/)
  })

  it("categories are chips plus a picker, not a wall", () => {
    // The grouped checkbox list lives inside the Popover; nothing renders it inline.
    const popover = what.indexOf("<PopoverContent")
    const groups = what.indexOf("{visibleGroups.map((group) => (")
    expect(popover).toBeGreaterThan(-1)
    expect(groups).toBeGreaterThan(popover)
    expect(what).toMatch(/aria-label=\{isPrimary \? `\$\{cat\.name\}, primary category` : `Make \$\{cat\.name\} the primary category`\}/)
  })

  it("Featured is admin-only on the screen AND on the API", () => {
    expect(who).toMatch(/\{canFeature \? \(/)
    for (const route of ["app/api/events/route.ts", "app/api/events/[id]/route.ts"]) {
      expect(read(route)).toMatch(
        /\.\.\.\(is_featured != null && session\.user\.role === "app_admin" && \{ is_featured \}\)/
      )
    }
    for (const page of ["app/dashboard/events/new/page.tsx", "app/dashboard/events/[id]/edit/page.tsx"]) {
      expect(read(page)).toMatch(/canFeature=\{session\.user\.role === "app_admin"\}/)
    }
  })

  it("cancelling is its own confirmed action in edit mode, not a dropdown value", () => {
    expect(form).toMatch(/window\.confirm\(/)
    expect(form).toMatch(/submitAs\("cancelled"\)/)
    expect(rail).toMatch(/isEditing && !cancelled && !compact \? \(/)
  })
})

describe("renderableImageUrl", () => {
  it("draws only what parses as an http(s) URL — the field is typed one character at a time", () => {
    expect(renderableImageUrl("")).toBeNull()
    expect(renderableImageUrl("h")).toBeNull()
    expect(renderableImageUrl("https:/")).toBeNull()
    expect(renderableImageUrl("javascript:alert(1)")).toBeNull()
    expect(renderableImageUrl("https://cdn/x.jpg")).toBe("https://cdn/x.jpg")
  })
})
