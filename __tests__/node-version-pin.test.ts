import { readFileSync, readdirSync } from "fs"
import { join } from "path"

/**
 * Production builds on the Node major CI tests on.
 *
 * Railpack picks the Node version from `RAILPACK_NODE_VERSION`, then
 * `package.json` `engines.node`, and falls back to `lts` when neither is set
 * (https://railpack.com/languages/node). Neither was set, so a fresh production
 * build could land on a major CI never ran. `engines.node` is the pin; this
 * keeps it equal to every `node-version:` in the workflows.
 */
const ROOT = join(__dirname, "..")
const WORKFLOWS = join(ROOT, ".github", "workflows")

const major = (v: string) => v.match(/\d+/)?.[0]

test("package.json engines.node has the major every workflow's node-version uses", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  const engines = major(pkg.engines?.node ?? "")

  const ciMajors = readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((f) =>
      [...readFileSync(join(WORKFLOWS, f), "utf8").matchAll(/^\s*node-version:\s*["']?([^"'\s#]+)/gm)].map(
        (m) => [f, major(m[1])],
      ),
    )

  expect(ciMajors.length).toBeGreaterThan(0)
  expect(engines).toBeDefined()
  expect(ciMajors).toEqual(ciMajors.map(([f]) => [f, engines]))
})
