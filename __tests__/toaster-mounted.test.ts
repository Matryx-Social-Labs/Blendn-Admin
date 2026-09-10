import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * If anything calls `toast.*`, a `<Toaster />` has to be rendered.
 *
 * `sonner` renders nothing without one. `components/ui/sonner.tsx` exported a
 * styled `Toaster` wrapper that **no file imported**, so all 148 `toast.*` call
 * sites across 44 files were discarded — 79 of them errors. Approving an
 * application, declining one, retiring a venue, removing a member, a refused
 * domain claim: the guard fired, the product said nothing, and the control read
 * as a dead button.
 *
 * That is not a bug you can see in a screenshot, which is why the guard is
 * structural. It was found by driving the dashboard in a browser: a deliberately
 * invalid domain (`gmail.com`) was correctly refused, and the refusal message
 * — which exists, and is well written — never reached the screen.
 *
 * Comments are stripped before matching. A guard that counts a mention in prose
 * as a mount is worse than no guard, because it reports green: the same failure
 * `event-notifications-reachable.test.ts` was written to avoid.
 */
const ROOT = join(__dirname, "..")

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

/** Every .ts/.tsx under app/ and components/. */
function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue
      const abs = join(dir, entry)
      if (statSync(abs).isDirectory()) walk(abs)
      else if (/\.tsx?$/.test(entry)) out.push(abs)
    }
  }
  walk(join(ROOT, "app"))
  walk(join(ROOT, "components"))
  return out
}

const files = sourceFiles().map((abs) => ({
  rel: abs.slice(ROOT.length + 1),
  src: stripComments(readFileSync(abs, "utf8")),
}))

const TOAST_CALL = /\btoast\.(success|error|info|warning|message)\s*\(/
const WRAPPER = join("components", "ui", "sonner.tsx")

describe("toast feedback actually reaches the screen", () => {
  it("has callers, so the assertion below is not vacuous", () => {
    /*
     * Pinned deliberately. If every `toast.*` call were deleted tomorrow the
     * mount assertion would pass trivially, and this guard would go quiet at
     * exactly the moment it stopped being about anything.
     */
    expect(files.filter((f) => TOAST_CALL.test(f.src)).length).toBeGreaterThan(0)
  })

  it("renders a Toaster somewhere in the tree", () => {
    /*
     * The *element*, not the import. `components/ui/sonner.tsx` both imports
     * sonner's Toaster and exports its own wrapper, so matching an import would
     * have been satisfied by the very file that was never mounted.
     *
     * The wrapper's own definition is excluded for the same reason: it renders
     * `<Sonner ...>`, and counting that as a mount is how this bug hid.
     */
    const mounts = files.filter((f) => f.rel !== WRAPPER && /<Toaster[\s/>]/.test(f.src))

    expect(mounts.map((m) => m.rel)).not.toHaveLength(0)
  })
})
