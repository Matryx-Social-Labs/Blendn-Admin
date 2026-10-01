import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * A colour utility that names no token renders nothing, and says nothing.
 *
 * The admin nav badge was `bg-destructive … text-destructive-foreground`, and
 * `--destructive-foreground` was never declared. Tailwind v4 generates no rule
 * for a colour it has no `--color-*` for, so the class was a no-op and the count
 * inherited the row's colour. On an inactive row that was muted grey on red,
 * measured at 1.53:1. tsc, lint, jest and the build were all green.
 *
 * Also keeps the two gradients at one value each. `--gradient-brand` was
 * declared twice in `globals.css`, the design kit had a different value, and
 * `DESIGN_SYSTEM.md` recorded a third.
 */

const ROOT = join(__dirname, "..")
const css = stripComments(readFileSync(join(ROOT, "app/globals.css"), "utf8"))

/** The declarations inside the first `<selector> {` block. No nested braces in these blocks. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`no ${selector} block in globals.css`)
  const body = css.slice(start, css.indexOf("}", start))
  const out = new Map<string, string>()
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  return out
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

const theme = block("@theme inline")
const root = block(":root")
const dark = block(".dark")

/*
 * The semantic colours: every `--x` the themes declare that is a colour (not a
 * gradient, a radius or a font). Tailwind's default palette (`text-red-500`)
 * is not checked; it always resolves.
 */
const NOT_COLOURS = /^--(gradient-|radius|font-|text-)/
const semantic = new Set(
  [...root.keys(), ...dark.keys()].filter((name) => !NOT_COLOURS.test(name)).map((name) => name.slice(2))
)

describe("every semantic colour utility resolves to a token", () => {
  const used = new Set<string>()
  const UTILITY = /\b(?:text|bg|border|ring|fill|stroke|outline|decoration|divide|placeholder)-([a-z]+(?:-[a-z]+)*)\b/g
  for (const dir of ["app", "components"]) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const src = readFileSync(file, "utf8")
      for (const m of src.matchAll(UTILITY)) {
        // `*-foreground` always, so a foreground the themes never declared is
        // caught too: that was the badge. Otherwise only names the themes use.
        if (m[1].endsWith("-foreground") || semantic.has(m[1])) used.add(m[1])
      }
    }
  }

  it("finds the utilities it exists to check, so a bad scan cannot pass on nothing", () => {
    expect([...used]).toEqual(
      expect.arrayContaining(["muted-foreground", "destructive-foreground", "warning", "success", "border-strong"])
    )
  })

  it.each([...used].sort())("%s has a --color-* entry in @theme", (token) => {
    expect(theme.has(`--color-${token}`)).toBe(true)
  })

  it("points each --color-* at a variable :root declares", () => {
    const dangling = [...theme]
      .filter(([name]) => name.startsWith("--color-"))
      .map(([name, value]) => [name, value.match(/^var\((--[\w-]+)\)$/)?.[1]] as const)
      .filter(([, target]) => target !== undefined && !root.has(target))
    expect(dangling).toEqual([])
  })

  it("declares in :root every colour the dark theme does, so the light theme has a value", () => {
    const missing = [...dark.keys()].filter((name) => !NOT_COLOURS.test(name) && !root.has(name))
    expect(missing).toEqual([])
  })

  it("gives the shipped dark theme its own badge foreground", () => {
    // The dark red under it is not the light one; the light theme's white
    // does not carry on it (DESIGN_SYSTEM.md, Colour).
    expect(dark.has("--destructive-foreground")).toBe(true)
  })
})

describe("the brand gradient carries no words", () => {
  it("never sits under a text colour in the same class list", () => {
    // DESIGN_SYSTEM.md, Gradients: no single label colour reads across the
    // brand gradient's sweep. Words go on `--gradient-ember`.
    const offenders: string[] = []
    for (const dir of ["app", "components"]) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        for (const m of readFileSync(file, "utf8").matchAll(/className="([^"]*--gradient-brand[^"]*)"/g)) {
          if (/(?:^|\s)text-(?!\[)(?!(?:xs|sm|base|lg|xl|\dxl)\b)[a-z-]+/.test(m[1])) offenders.push(`${file.replace(`${ROOT}/`, "")}: ${m[1]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("one value per gradient", () => {
  const declarations = (name: string) => [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, "g"))].map((m) => m[1].trim())

  it.each(["--gradient-brand", "--gradient-ember"])("%s is declared once", (name) => {
    expect(declarations(name)).toHaveLength(1)
  })

  it.each(["--gradient-brand", "--gradient-ember"])("DESIGN_SYSTEM.md quotes %s as globals.css declares it", (name) => {
    const doc = readFileSync(join(ROOT, "docs/DESIGN_SYSTEM.md"), "utf8")
    expect(doc).toContain(`${name}: ${declarations(name)[0]}`)
  })
})
