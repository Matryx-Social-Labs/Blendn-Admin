/**
 * The house apostrophe is ’ wherever a person reads it (S-3, S-4; the app's
 * own `houseApostrophe.test.ts`): a push, a bell row, a refusal the app or the
 * dashboard shows, an email. Every string and template literal in `lib/` and
 * `app/api/mobile/` is read with the compiler, so comments never count.
 *
 * Not copy, and left alone: the OpenAPI descriptions (developers read them),
 * log lines, thrown `Error`s (internal, never shown), and tagged templates
 * (SQL). An email's HTML entity for ' between letters counts as copy.
 */
import fs from "fs"
import path from "path"
import ts from "typescript"

const ROOT = path.join(__dirname, "..")
const TYPEWRITER = /[A-Za-z}]'[A-Za-z]|[A-Za-z](&#39;|&#x27;|&apos;)[A-Za-z]/

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return p.includes(path.join("lib", "openapi")) ? [] : walk(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })

/** Inside a log call, a thrown Error or a tagged template: not something a person reads. */
function internal(node: ts.Node): boolean {
  for (let p = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isTaggedTemplateExpression(p)) return true
    if (ts.isNewExpression(p) && /Error$/.test(p.expression.getText())) return true
    if (ts.isCallExpression(p) && /^(logger|console)\.\w+$/.test(p.expression.getText())) return true
    if (ts.isFunctionLike(p) || ts.isBlock(p)) return false
  }
  return false
}

export function typewriterApostrophes(files: string[]): string[] {
  return files.flatMap((file) => {
    const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
    const found: string[] = []
    const visit = (n: ts.Node) => {
      const literal =
        ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)
      if (literal && TYPEWRITER.test(n.text) && !internal(n)) {
        found.push(`${path.relative(ROOT, file)}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`)
      }
      ts.forEachChild(n, visit)
    }
    visit(src)
    return found
  })
}

it("no copy in lib/ or app/api/mobile/ carries a typewriter apostrophe", () => {
  const files = [path.join(ROOT, "lib"), path.join(ROOT, "app", "api", "mobile")].flatMap(walk)
  expect(typewriterApostrophes(files)).toEqual([])
})
