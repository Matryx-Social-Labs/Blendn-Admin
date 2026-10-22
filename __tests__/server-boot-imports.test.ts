import { existsSync, readFileSync } from "fs"
import { dirname, join, resolve } from "path"

/**
 * The custom server (`server.ts`, compiled by tsconfig.server.json and run by
 * plain Node) cannot load a module that imports "server-only": that package
 * throws outside Next's bundler, and the process dies at boot. Step 17 nearly
 * shipped one — the sponsored scheduler importing lib/sponsor-reach.ts for the
 * reach sweep. This walks every runtime import reachable from server.ts.
 */
const ROOT = process.cwd()
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g

function resolveLocal(spec: string, from: string): string | null {
  const base = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null
  if (!base) return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate
  }
  return null
}

function closure(entry: string): { files: Set<string>; serverOnly: string[] } {
  const files = new Set<string>()
  const serverOnly: string[] = []
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop()!
    if (files.has(file)) continue
    files.add(file)
    const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    for (const m of src.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3]
      if (spec === "server-only") serverOnly.push(file.slice(ROOT.length + 1))
      const next = resolveLocal(spec, file)
      if (next) stack.push(next)
    }
  }
  return { files, serverOnly }
}

describe("the custom server boots without a server-only module", () => {
  const { files, serverOnly } = closure(join(ROOT, "server.ts"))

  it("walks the server's real import graph (the socket server and the sponsored scheduler are in it)", () => {
    const rel = [...files].map((f) => f.slice(ROOT.length + 1))
    expect(rel).toEqual(expect.arrayContaining(["lib/socket-server.ts", "lib/sponsored-scheduler.ts"]))
  })

  it("imports \"server-only\" nowhere in that graph", () => {
    expect(serverOnly).toEqual([])
  })
})
