/**
 * The names the owner retired on 2026-11-05 (SCRUM-1027, `.context/plans/naming-review.md` in blendn-admin) never come
 * back in a string a person reads: the Board is the Lobby, the crew match is a Mix, "blend in" is "Blend’n", the organizer’s
 * Event Pass is Event Insights, the venue door pass is an offer code, spaces are spots, "Liking as" is "Sending as", and "centre" is "center".
 *
 * A source pin over `app/`, `components/` and `lib/` (dashboard copy, legal pages, API errors, push and email templates,
 * OpenAPI descriptions), read through the TypeScript parser like the client’s `brandSpelling.test.ts`:
 * string literals, template parts and JSX text count; comments, imports and code identifiers (`BoardPost`, `blendId`)
 * never do. A literal with no space that does not start with a capital is a route, a key, a kind or a testID
 * (`/board/[eventId]`, `'blend'`, `board-top`), never copy, so it is skipped. Brand words stay: Blend’n, Blend’n+.
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const ROOT = path.join(__dirname, '..')
const DIRS = ['app', 'components', 'lib']

/** Each retired name, as it can appear in copy. */
const BANNED: readonly { name: string; pattern: RegExp }[] = [
  { name: 'Board (now Lobby)', pattern: /\b[Bb]oard\b(?![- ]?gam)/ },
  { name: 'blend in (now Blend’n)', pattern: /\bblend(s|ed|ing)? in\b/i },
  { name: 'Blend, the crew match (now Mix)', pattern: /\bBlends?\b(?!['’]n|&apos;n|&rsquo;n)/ },
  { name: 'Event Pass (now Event Insights)', pattern: /\bEvent Pass(es)?\b/i },
  { name: 'door pass (now offer code)', pattern: /\bdoor pass/i },
  { name: 'spaces left (now spots)', pattern: /\bspaces? left\b/i },
  { name: 'Liking as (now Sending as)', pattern: /\bliking as\b/i },
  { name: 'centre (now center)', pattern: /\bcentr(e|es|ed|ing)\b/i },
]


/** A route, a key, a kind or a testID: no space, and no capital to start. */
const isIdentifierLike = (s: string) => !/\s/.test(s) && !/^[A-Z]/.test(s)

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(rel)
    return /\.(ts|tsx)$/.test(entry.name) ? [rel] : []
  })
}

/** Every piece of text the source hands to the screen: string literals, template parts, JSX text. Not imports. */
function copyIn(source: string, name = 'x.tsx'): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    // A log line is for us, not for a person using the product, and Sentry groups on its words.
    if (ts.isCallExpression(node) && /^(logger|console)\.\w+$/.test(node.expression.getText())) return
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      const text = node.text.trim()
      if (text && !isIdentifierLike(text)) out.push(text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

/** A `code span` in a description names a field, a route or an event (`board:postRemoved`), not the feature. */
const prose = (text: string) => text.replace(/`[^`]*`/g, '')

const offences = (texts: string[]) =>
  texts.flatMap((text) => BANNED.filter((b) => b.pattern.test(prose(text))).map((b) => `${b.name}: “${text.slice(0, 120)}”`))

describe('retired names stay retired (naming review 2026-11-05)', () => {
  it('in every string under app/, components/ and lib/', () => {
    const files = DIRS.flatMap(sources)
    expect(files.length).toBeGreaterThan(300)
    const found = files.flatMap((rel) => offences(copyIn(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel)).map((o) => `${rel} · ${o}`))
    expect(found).toEqual([])
  })

  it('catches each old name planted in copy', () => {
    const planted = [
      '<p>The Board</p>',
      "title: 'This board isn’t here'",
      "label: 'Hold to blend in'",
      'const t = `Blend with ${name}`',
      '<h2>Event Pass</h2>',
      '<p>Redeem a door pass</p>',
      "toast: 'It’s a Blend'",
      "'2 spaces left'",
      "<p>Liking as</p>",
      "title=\"Help centre\"",
    ]
    for (const source of planted) expect({ source, hits: offences(copyIn(source)).length }).toEqual({ source, hits: 1 })
  })

  it('lets the new names, the brand, routes, keys and words that only contain “board” through', () => {
    const fine = [
      "<p>The Lobby</p>",
      "label: 'Hold to Blend’n'",
      "'Blend’n+ is on'",
      "'Mix with Nebula'",
      "<p>Event Insights opens one event</p>",
      "<p>Blend&apos;n is an app for meeting people</p>",
      'logger.error("Board read error", { error })',
      "const info = 'blendn door-pass v1'",
      "router.push('/board/[eventId]')",
      "kind === 'blend'",
      'testID="board-top"',
      "'Open the dashboard'",
      "'Finish onboarding'",
      "'Copied to the clipboard'",
      "'Board gamers'",
      "// the Board, in a comment",
      "import { BoardEntry } from '../components/board/BoardSections'",
    ]
    for (const source of fine) expect({ source, hits: offences(copyIn(source)) }).toEqual({ source, hits: [] })
  })
})
