import { existsSync, readFileSync } from "fs"
import { dirname, join, relative, resolve } from "path"

/**
 * Nothing reachable from `server.ts` may import through the `@/` alias.
 *
 * `build:server` compiles the custom server with plain `tsc`, which resolves
 * `@/` for **typechecking** and then emits it verbatim into the `require()`.
 * Node has no such alias at runtime, so the build goes green, CI passes, the
 * image builds — and the container dies on boot with `MODULE_NOT_FOUND`.
 *
 * Every layer that could plausibly catch this is blind to it:
 *
 *   - `tsc --noEmit` resolves the alias and is satisfied
 *   - `next build` never loads the compiled server at all
 *   - the unit suite imports through Jest's moduleNameMapper, which also
 *     resolves the alias
 *
 * So the first thing that notices is the deploy failing to come up. Individual
 * files carry a comment warning about it, but a comment only helps someone who
 * already knows to look — and the hazard is invisible from the file being
 * edited. Adding one aliased import to a module three hops from `server.ts` is
 * enough.
 *
 * This walks the real import graph from `server.ts` and fails on the first
 * alias, naming the chain that made the file reachable.
 */

const ROOT = resolve(__dirname, "..")

/** Resolve a relative specifier to a real .ts file, mirroring Node/tsc lookup. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8")
  const found: string[] = []
  // `import … from "x"`, `export … from "x"`, and `require("x")`.
  for (const m of source.matchAll(/(?:from|require\()\s*["']([^"']+)["']/g)) {
    found.push(m[1])
  }
  return found
}

describe("the custom server's import graph", () => {
  it("never reaches an @/ alias", () => {
    const entry = join(ROOT, "server.ts")
    const seen = new Set<string>()
    // How each file became reachable, so a failure names the chain rather than
    // just the offending file.
    const via = new Map<string, string>()
    const violations: string[] = []
    const queue = [entry]

    while (queue.length > 0) {
      const file = queue.shift()!
      if (seen.has(file)) continue
      seen.add(file)

      for (const specifier of importsOf(file)) {
        if (specifier.startsWith("@/")) {
          const chain: string[] = [relative(ROOT, file)]
          for (let at = via.get(file); at; at = via.get(at)) chain.push(relative(ROOT, at))
          violations.push(`${specifier} imported by ${chain.reverse().join(" → ")}`)
          continue
        }
        // Bare specifiers are node_modules; they resolve fine at runtime.
        if (!specifier.startsWith(".")) continue

        const target = resolveLocal(file, specifier)
        if (target && !seen.has(target)) {
          via.set(target, file)
          queue.push(target)
        }
      }
    }

    // Guards the guard: if the walk silently resolved nothing, an empty
    // violations list would be meaningless.
    expect(seen.size).toBeGreaterThan(5)
    expect(violations).toEqual([])
  })
})
