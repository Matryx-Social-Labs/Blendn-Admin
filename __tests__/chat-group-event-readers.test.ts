import { readFileSync } from "fs"
import { join, relative } from "path"
import ts from "typescript"

/**
 * Every reader of a room's event knows the room might not have one (TQ-A10,
 * CR-G02, F8).
 *
 * `chat_groups.event_id` was NOT NULL: every room was an event's. Now a board
 * post's room has none (and a crew's or Blend's will not), and the type says
 * so — so a reader that forgets fails to compile. What the compiler cannot stop
 * is the two ways a hurried fix makes it compile:
 *
 *   - a stand-in: `room.event ?? { status: "published", deleted_at: null }`,
 *     `|| {…}`, `room.event!`, `cond ? room.event : {…}`, or a destructuring
 *     default `const { event = {…} } = room`, which opens a room nobody owns;
 *   - a new reader in a function nobody looked at, which treats every room as
 *     an event's (`toChatRoom` silently dropping a room's messages was one).
 *
 * So the first is refused everywhere, and every read of a room's event is
 * allowed only inside a function listed below with why it is right for a room
 * of any kind.
 *
 * ## Found by type, not by name
 *
 * The scan asks the TypeScript checker, over the same program `tsc` builds:
 * a read of `.event` / `.event_id` — dotted, bracketed, optional-chained or
 * destructured, whatever the variable is called — whose property type admits
 * null. `chat_groups` is the only model whose event is nullable, so that is a
 * room's event and nothing else (checked below: an event read on any other
 * model is never reported). A read after a guard narrowed it is a read of a
 * non-null value, and needs no entry.
 */

const ROOT = join(__dirname, "..")
const SEARCH = ["app/", "lib/", "components/", "scripts/", "server.ts"]
const NAMES = new Set(["event", "event_id"])

/** `file#function` → why a read of a room's event there is right for a room of any kind. */
const READERS: Record<string, string> = {
  "lib/room-kind.ts#roomOwnerDenial": "the door: switches on kind, and an event room without its event is refused",
  "lib/room-kind.ts#roomReadDenialFor": "the event arm only; an event room without its event is hidden",
  "lib/room-kind.ts#mayWriteToRoomFor": "the event arm only; an event room without its event is hidden",
  "lib/room-kind.ts#roomWindowFor": "the event arm only; an event room without its event is closed",
  "lib/room-kind.ts#roomScope": "an event room's handle scope; throws, never invents, when the event is missing",
  "app/api/mobile/chat/groups/route.ts#GET": "lists event rooms only (kind: 'event' in the where), narrowed with nothing to fall back on",
  "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts#GET":
    "sender names: a null event names a broadcast 'Organiser', never a person (roomSenderName)",
  "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts#POST": "the quoted reply's sender name, as GET",
  "app/api/mobile/chat/groups/[chatGroupId]/report/route.ts#POST": "a room report is filed against an event; a room of any other kind is refused",
  "app/api/mobile/events/[eventId]/chat/route.ts#GET": "the room is found by its event; without it, no room",
  "app/api/mobile/events/[eventId]/chat/route.ts#POST": "the room is found by its event; without it, no room",
  "app/dashboard/moderation/actions.ts#getModerationQueue": "the admin queue's label; no event reads 'Unknown event'",
  "app/dashboard/moderation/reports/actions.ts#getReportQueue": "the admin queue's label; no event stays null",
  "lib/polls.ts#getPollResults": "polls are an event room's: the URL's event must be the room's, else not found",
  "lib/polls.ts#castVote": "polls are an event room's: the URL's event must be the room's, else not found",
  "lib/sentiment-sweeper.ts#sweepSentiment": "selects event rooms only (kind = 'event')",
}

interface Read {
  key: string
  at: string
  text: string
  standIn: string | null
}

const nullable = (t: ts.Type): boolean =>
  !!(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) || (t.isUnion() && t.types.some(nullable))

const unwrap = (n: ts.Node): ts.Node => (n.parent && ts.isParenthesizedExpression(n.parent) ? unwrap(n.parent) : n)

/** The nearest named function around a node: `GET`, `canJoinChat`, a `const x = () =>`; else `<module>`. */
function enclosing(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText()
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent) {
      const p = n.parent
      if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && ts.isIdentifier(p.name)) return p.name.text
    }
  }
  return "<module>"
}

const isObjectish = (n: ts.Node) => ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n)

/** How a read stands in for a missing event, if it does. */
function standInOf(read: ts.Node): string | null {
  if (ts.isBindingElement(read)) return read.initializer ? "destructuring default" : null
  const outer = unwrap(read)
  const p = outer.parent
  if (ts.isNonNullExpression(p)) return "non-null assertion"
  if (ts.isBinaryExpression(p) && p.left === outer) {
    const op = p.operatorToken.kind
    const right = p.right.kind
    const toNothing = right === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(p.right) && p.right.text === "undefined")
    if ((op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) && !toNothing) return "default"
  }
  // `cond ? room.event : {…}`: the read is a branch, and an object is the other.
  // A read in the condition is a guard (`room.event ? use(room.event) : refuse`).
  if (ts.isConditionalExpression(p)) {
    if (p.whenTrue === outer && isObjectish(p.whenFalse)) return "ternary with a stand-in"
    if (p.whenFalse === outer && isObjectish(p.whenTrue)) return "ternary with a stand-in"
  }
  return null
}

function scan(program: ts.Program, files: string[]): Read[] {
  const checker = program.getTypeChecker()
  const reads: Read[] = []
  const report = (sf: ts.SourceFile, node: ts.Node, receiverType: ts.Type, name: string) => {
    const prop = checker.getNonNullableType(receiverType).getProperty(name)
    if (!prop || !nullable(checker.getTypeOfSymbolAtLocation(prop, node))) return
    const file = relative(ROOT, sf.fileName)
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
    reads.push({ key: `${file}#${enclosing(node)}`, at: `${file}:${line}`, text: node.getText().slice(0, 80), standIn: standInOf(node) })
  }
  for (const f of files) {
    const sf = program.getSourceFile(f)
    if (!sf) continue
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && NAMES.has(node.name.text)) {
        report(sf, node, checker.getTypeAtLocation(node.expression), node.name.text)
      } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && NAMES.has(node.argumentExpression.text)) {
        report(sf, node, checker.getTypeAtLocation(node.expression), node.argumentExpression.text)
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && NAMES.has(key.text)) {
          report(sf, node, checker.getTypeAtLocation(node.parent), key.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return reads
}

function parsedConfig() {
  const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile)
  return ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT)
}

describe("readers of a room's event (F8)", () => {
  const parsed = parsedConfig()
  const files = parsed.fileNames.filter((f) => SEARCH.some((s) => relative(ROOT, f).startsWith(s)))
  let reads: Read[] = []

  beforeAll(() => {
    reads = scan(ts.createProgram(files, parsed.options), files)
  }, 120_000)

  it("scans the tree and finds the readers it knows", () => {
    expect(files.length).toBeGreaterThan(300)
    expect(reads.some((r) => r.key === "lib/room-kind.ts#roomOwnerDenial")).toBe(true)
  })

  it("never stands in for a missing event", () => {
    expect(reads.filter((r) => r.standIn).map((r) => `${r.at} ${r.standIn}: ${r.text}`)).toEqual([])
  })

  it("reads a room's event only where it was decided", () => {
    const undecided = [...new Set(reads.filter((r) => !(r.key in READERS)).map((r) => `${r.key} (${r.at}: ${r.text})`))]
    expect(undecided).toEqual([])
  })

  it("lists no function that no longer reads one (the list stays true)", () => {
    const seen = new Set(reads.map((r) => r.key))
    expect(Object.keys(READERS).filter((k) => !seen.has(k))).toEqual([])
  })
})

describe("the scan finds a room's event by type, whatever it is called (probe shapes)", () => {
  const PROBE = join(ROOT, "__probe__", "room-event-probes.ts")
  const SOURCE = `
    import type { Prisma } from "@prisma/client"
    type Room = Prisma.chat_groupsGetPayload<{ select: { id: true; event_id: true; event: { select: { status: true; deleted_at: true } } } }>
    type Post = Prisma.board_postsGetPayload<{ select: { event_id: true; event: { select: { status: true } } } }>
    declare const g: Room
    declare const cg: Room
    declare const post: Post
    const OPEN = { status: "published" as const, deleted_at: null }
    export function standIns() {
      const a = g.event ?? OPEN
      const b = cg.event_id!
      const { event = OPEN } = g
      const c = g["event"] || { ...OPEN }
      const d = cg.event ? cg.event : { status: "published", deleted_at: null }
      const { event_id: renamed } = cg
      return [a, b, event, c, d, renamed]
    }
    export function notARoom() {
      // A board post's event is never null: not a room's, never reported.
      return [post.event, post.event_id, post.event ?? OPEN]
    }
    export function guarded() {
      return g.event ? g.event.status : "hidden"
    }
  `
  let reads: Read[] = []

  beforeAll(() => {
    const parsed = parsedConfig()
    const host = ts.createCompilerHost(parsed.options)
    const getSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (name, lang, ...rest) =>
      name === PROBE ? ts.createSourceFile(name, SOURCE, lang) : getSourceFile(name, lang, ...rest)
    const fileExists = host.fileExists.bind(host)
    host.fileExists = (name) => name === PROBE || fileExists(name)
    host.readFile = ((readFile) => (name: string) => (name === PROBE ? SOURCE : readFile(name)))(host.readFile.bind(host))
    reads = scan(ts.createProgram([PROBE], parsed.options, host), [PROBE])
  }, 120_000)

  it("reports every stand-in shape: ??, !, a destructuring default, bracket ||, a ternary", () => {
    expect(reads.filter((r) => r.standIn).map((r) => [r.text, r.standIn])).toEqual([
      ["g.event", "default"],
      ["cg.event_id", "non-null assertion"],
      ["event = OPEN", "destructuring default"],
      ['g["event"]', "default"],
      ["cg.event", "ternary with a stand-in"],
    ])
  })

  it("reports a renamed destructure as a read, and nothing on another model", () => {
    expect(reads.some((r) => r.text === "event_id: renamed" && r.key.endsWith("#standIns"))).toBe(true)
    expect(reads.filter((r) => r.key.endsWith("#notARoom"))).toEqual([])
  })

  it("lets a guard through: a ternary that falls back to a refusal is not a stand-in", () => {
    const guarded = reads.filter((r) => r.key.endsWith("#guarded"))
    expect(guarded.length).toBeGreaterThan(0)
    expect(guarded.filter((r) => r.standIn)).toEqual([])
  })

  it("is not a regex: the source file it reads has no name the old guard knew", () => {
    expect(readFileSync(__filename, "utf8")).toContain("getTypeOfSymbolAtLocation")
  })
})
