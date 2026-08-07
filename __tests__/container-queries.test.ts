import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative, resolve } from "path"

/**
 * Dashboard screens size themselves against the content column, not the window.
 *
 * The sidebar is 16rem and collapsible, so the viewport is the wrong thing to
 * measure. `lg:grid-cols-3` fires at 1024px of *window* whether the sidebar is
 * eating 256px of it or not — which means the same screen breaks to three
 * columns in a 720px column and stays at one in a 1024px column. The breakpoint
 * describes the window; the layout problem is about the column.
 *
 * `app/dashboard/layout.tsx` puts `@container/main` on `<main>` for exactly
 * this, and most of the dashboard already keys off it. This stops the rest
 * drifting back.
 *
 * Two things are deliberately still viewport-based:
 *
 *   - **padding** (`lg:px-6`) mirrors the shell's own padding, and an element
 *     cannot query the container it establishes
 *   - **overlays** — a `Sheet` or `Dialog` is anchored to the window and is not
 *     inside the content column at all
 */

const ROOT = resolve(__dirname, "..")
const DIRS = [join(ROOT, "app/dashboard"), join(ROOT, "components/dashboard")]

/** Utilities that place or size an element within the content column. */
const LAYOUT_UTILITY =
  /\b(sm|md|lg|xl|2xl):(grid-cols-|flex-row|flex-col|col-span-|table-cell|inline-flex|inline\b|block\b|flex\b|hidden\b|items-|justify-|order-|w-fit|ml-0)/

/** Anchored to the window, not to `main`. */
const OVERLAY = /(SheetContent|DialogContent|DrawerContent|PopoverContent)/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith(".tsx")) out.push(full)
  }
  return out
}

describe("dashboard screens use container queries, not viewport breakpoints", () => {
  it("has no viewport breakpoint on a layout utility", () => {
    const offenders: string[] = []

    for (const dir of DIRS) {
      for (const file of walk(dir)) {
        const lines = readFileSync(file, "utf8").split("\n")
        lines.forEach((line, i) => {
          if (!LAYOUT_UTILITY.test(line)) return
          // An overlay's own className is measured against the window.
          if (OVERLAY.test(line) || (i > 0 && OVERLAY.test(lines[i - 1]))) return
          offenders.push(`${relative(ROOT, file)}:${i + 1}  ${line.trim().slice(0, 90)}`)
        })
      }
    }

    // Guards the guard: an empty file list would pass vacuously.
    expect(walk(DIRS[0]).length).toBeGreaterThan(10)
    expect(offenders).toEqual([])
  })
})
