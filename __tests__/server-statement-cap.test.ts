import { readFileSync } from "fs"
import { join } from "path"

/**
 * SCRUM-1221: the server's statements are capped at 8 s and scripts that import lib/db are not, and the only thing
 * that makes the difference is one line in server.ts. Every itest sets the variable itself, so without this the default
 * could vanish (or move after the first connection) with the whole suite green and production running uncapped.
 */
const src = readFileSync(join(process.cwd(), "server.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

it("server.ts defaults DATABASE_STATEMENT_TIMEOUT_MS to 8000 and checks it before Next or the loops can connect", () => {
  const setDefault = src.search(/process\.env\.DATABASE_STATEMENT_TIMEOUT_MS = process\.env\.DATABASE_STATEMENT_TIMEOUT_MS\?\.trim\(\) \|\| "8000"/)
  const check = src.search(/statementTimeoutMs\(\)/)
  expect(setDefault).toBeGreaterThan(-1)
  expect(check).toBeGreaterThan(setDefault)
  for (const firstUse of ["app.prepare(", "startBackgroundWork()", "initSocketServer("]) {
    expect(src.indexOf(firstUse)).toBeGreaterThan(check)
  }
})
