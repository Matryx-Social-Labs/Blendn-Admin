import { readFileSync } from "fs"
import { join } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * /api-docs loads Swagger UI prebuilt, never through our bundler (SCRUM-463).
 *
 * `swagger-ui-react` handed apidom's module graph to Turbopack, which skipped
 * the modules that attach `refract` to each OpenAPI 3.1 element class (they
 * exist for their side effects, and their exports are re-exports). The page
 * threw `oS.refract is not a function`, and no Next
 * tree-shaking flag brought the modules back. Nothing but a browser on a
 * production build shows it, so this keeps the page on the prebuilt bundle.
 */
const ROOT = join(__dirname, "..")

it("imports swagger-ui-dist's prebuilt bundle, and swagger-ui-react is not a dependency", () => {
  const page = stripComments(readFileSync(join(ROOT, "app/api-docs/page.tsx"), "utf8"))
  expect(page).toContain('import("swagger-ui-dist/swagger-ui-bundle.js")')
  expect(page).not.toContain("swagger-ui-react")

  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, Record<string, string>>
  expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty("swagger-ui-react")
})
