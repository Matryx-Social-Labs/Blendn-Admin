/**
 * CSV generation.
 *
 * No dependency: RFC 4180 is one quoting rule, and the interesting parts of
 * this file are the two things a library would not do for us anyway — the BOM
 * for Excel, and the formula-injection guard.
 *
 * Pinned by __tests__/csv.test.ts.
 */

/**
 * A cell beginning with `=`, `+`, `-` or `@` is executed as a formula when the
 * file is opened in Excel, Sheets or LibreOffice.
 *
 * An event titled `=cmd|'/c calc'!A1` is a real attack against whoever opens
 * the export, and event titles come from the public side of this product. The
 * fix is a leading apostrophe, which those applications strip on display and
 * treat as "this is text".
 *
 * Tab and carriage return are included because they are also treated as formula
 * starts once the cell is parsed.
 */
function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return ""

  let text: string
  if (value instanceof Date) {
    // ISO, not locale: a report opened in another timezone must not silently
    // shift every date by a day.
    text = value.toISOString()
  } else if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : ""
  } else if (typeof value === "boolean") {
    return value ? "true" : "false"
  } else {
    text = String(value)
  }

  text = neutraliseFormula(text)

  // Quote when the cell contains a delimiter, a quote, or a newline. Inner
  // quotes double.
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export interface CsvColumn<T> {
  key: string
  label: string
  value?: (row: T) => unknown
}

/**
 * @param columns header labels and how to read each cell
 * @param rows the data
 */
export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const header = columns.map((c) => escapeCell(c.label)).join(",")
  const body = rows.map((row) =>
    columns
      .map((c) =>
        // `key` indexes the row when no `value` is given. Cast because T is
        // deliberately unconstrained — constraining it to a record breaks
        // inference on every Prisma select result at the call sites.
        escapeCell(c.value ? c.value(row) : (row as Record<string, unknown>)[c.key])
      )
      .join(",")
  )
  // CRLF per RFC 4180. Excel on Windows is the main consumer of these.
  return [header, ...body].join("\r\n")
}

/**
 * The UTF-8 BOM.
 *
 * Without it Excel reads a UTF-8 CSV as the local 8-bit codepage, so every
 * non-ASCII character in the export — which for this product means a great many
 * venue and organiser names — arrives mojibaked.
 */
/* Written as an escape, not as a literal character: a literal BOM is invisible
   in an editor and does not survive a copy-paste or a linter's whitespace pass,
   which is exactly how it went missing the first time. */
export const UTF8_BOM = "\uFEFF"

export function csvResponse(filename: string, csv: string): Response {
  return new Response(UTF8_BOM + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      // Quoted, because the filename carries a date and may carry a venue name.
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      // A report is a point-in-time snapshot; a cached one is a wrong one.
      "Cache-Control": "no-store",
    },
  })
}

/** `blendn-events-2026-08-05.csv` — sortable, and says what it is. */
export function reportFilename(kind: string, from: Date, to: Date): string {
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const range = iso(from) === iso(to) ? iso(from) : `${iso(from)}_${iso(to)}`
  return `blendn-${kind}-${range}.csv`
}

/** One record of a CSV, with the physical line it starts on (1-based), for messages a person acts on. */
export interface CsvRow {
  line: number
  cells: string[]
}

/**
 * Read a CSV: RFC 4180's one quoting rule, in reverse.
 *
 * Quoted cells may hold commas, doubled quotes and newlines — a Google Maps URL
 * holds commas (`@12.97,77.64,17z`), so a split on "," is not a parser. A quote
 * opens a quoted cell only at the start of one (spaces before it allowed, as
 * spreadsheets write `a, "b"`); mid-cell (`12" Pizza`) it is a character. An
 * unterminated quote throws rather than swallowing the rest of the file. A
 * leading BOM (Excel's, see `UTF8_BOM`) is dropped; blank lines are skipped.
 * No type coercion: every cell is a string, trimmed by the caller.
 */
export function parseCsvRows(text: string): CsvRow[] {
  const rows: CsvRow[] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  let line = 1
  let rowStart = 1
  let quoteOpenedOn = 0
  const input = text.startsWith(UTF8_BOM) ? text.slice(1) : text

  const endRow = () => {
    row.push(cell)
    if (row.some((c) => c.trim() !== "")) rows.push({ line: rowStart, cells: row })
    row = []
    cell = ""
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const newline = ch === "\n" || (ch === "\r" && input[i + 1] !== "\n")
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        cell += ch
      }
    } else if (ch === '"' && cell.trim() === "") {
      quoted = true
      quoteOpenedOn = line
      cell = ""
    } else if (ch === ",") {
      row.push(cell)
      cell = ""
    } else if (ch === "\n" || ch === "\r") {
      if (newline) {
        endRow()
        rowStart = line + 1
      }
    } else {
      cell += ch
    }
    if (newline) line++
  }
  if (quoted) throw new Error(`Unterminated quote: the cell opened on line ${quoteOpenedOn} never closes`)
  if (cell !== "" || row.length > 0) endRow()
  return rows
}
