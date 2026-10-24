/**
 * The house apostrophe is ’ wherever a person reads it (S-3, S-4; the app's
 * own `houseApostrophe.test.ts`): a push, a bell row, a refusal the app or the
 * dashboard shows, an email. Every string and template literal in `lib/` and
 * `app/api/mobile/` is read with the compiler, so comments never count.
 *
 * Not copy, and left alone: the OpenAPI descriptions (developers read them),
 * log lines, thrown `Error`s (internal, never shown), and tagged templates
 * (SQL). An email's HTML entity for ' between letters counts as copy.
 *
 * Nor a matcher: a keyword list compared with what people TYPE must keep the
 * typewriter apostrophe, or "don't" stops matching. Only an ARRAY OF STRINGS
 * can be one: put a comment that begins `house-apostrophe: matcher` directly
 * on its own declaration or property, and say why. A single string, an object
 * holding the array, or a comment that only mentions the phrase does not
 * count. A RegExp literal is never scanned (it is not a string literal). Every
 * marked place is pinned in `MARKED` below, so a new one fails CI until it is
 * reviewed and added.
 */
import fs from "fs"
import os from "os"
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

/** The reviewed matcher lists, as `path:line` of their marker comment. Empty: none exists today. */
const MARKED: string[] = []

/** A comment that BEGINS with the marker, not one that mentions it. */
const isMarker = (comment: string) => /^(\/\/|\/\*+)\s*house-apostrophe: matcher\b/.test(comment.trim())

const hasMarker = (node: ts.Node, text: string) =>
  (ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []).some((c) => isMarker(text.slice(c.pos, c.end)))

/**
 * Is this literal an element of an array of strings whose own declaration or
 * property carries the marker? Only that shape is a matcher list.
 */
function markedMatcher(node: ts.Node, text: string): boolean {
  const array = node.parent
  if (!ts.isArrayLiteralExpression(array)) return false
  if (!array.elements.every((e) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) return false
  let owner: ts.Node = array.parent
  while (ts.isAsExpression(owner) || ts.isSatisfiesExpression(owner) || ts.isParenthesizedExpression(owner)) owner = owner.parent
  if (ts.isVariableDeclaration(owner)) return hasMarker(owner.parent.parent, text) // the VariableStatement
  return ts.isPropertyAssignment(owner) && hasMarker(owner, text)
}

/**
 * Every marker comment in these files, as `path:line`: a line that begins with one. Line-based on purpose: a token
 * scanner without the parser loses its place inside template literals. A marker that begins no line counts nowhere
 * (`hasMarker` reads leading comments), so this finds every one that could.
 */
function markerComments(files: string[]): string[] {
  const MARKER_LINE = /^\s*(\/\/|\/\*+)\s*house-apostrophe: matcher\b/
  return files.flatMap((file) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) => (MARKER_LINE.test(line) ? [`${path.relative(ROOT, file)}:${i + 1}`] : []))
  )
}

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
    const text = fs.readFileSync(file, "utf8")
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const found: string[] = []
    const visit = (n: ts.Node) => {
      const literal =
        ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)
      if (literal && TYPEWRITER.test(n.text) && !internal(n) && !markedMatcher(n, text)) {
        found.push(`${path.relative(ROOT, file)}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`)
      }
      ts.forEachChild(n, visit)
    }
    visit(src)
    return found
  })
}

const SCANNED = () => [path.join(ROOT, "lib"), path.join(ROOT, "app", "api", "mobile")].flatMap(walk)

it("no copy in lib/ or app/api/mobile/ carries a typewriter apostrophe", () => {
  expect(typewriterApostrophes(SCANNED())).toEqual([])
})

it("every matcher marker is one already reviewed (MARKED)", () => {
  expect(markerComments(SCANNED())).toEqual(MARKED)
})

it("only a marked array of strings is a matcher: not a marked single string, an enclosing object, or a mention", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "house-apostrophe-"))
  const file = path.join(dir, "sample.ts")
  fs.writeFileSync(
    file,
    [
      "// house-apostrophe: matcher — compared with what people type",
      'export const TYPED = ["don\'t", "can\'t"] as const',
      "// house-apostrophe: matcher",
      'export const ONE = "won\'t"',
      "// house-apostrophe: matcher",
      "export const words = {",
      '  inner: ["isn\'t"],',
      "  // house-apostrophe: matcher",
      '  banned: ["shan\'t"],',
      "}",
      "// See house-apostrophe: matcher, which this is not",
      'export const MENTIONED = ["ain\'t"]',
      'export const SHOWN = "It\'s a Blend"',
    ].join("\n")
  )
  try {
    const lines = (at: string[]) => at.map((a) => a.split(":").pop())
    // Flagged: the marked single string (4), the array inside a marked object (7), the mention (12), the copy (13).
    expect(lines(typewriterApostrophes([file]))).toEqual(["4", "7", "12", "13"])
    // The markers found, and the mention is not one.
    expect(lines(markerComments([file]))).toEqual(["1", "3", "5", "8"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
