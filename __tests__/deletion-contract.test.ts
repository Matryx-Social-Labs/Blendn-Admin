import { readFileSync } from "fs"
import { join } from "path"

/**
 * Every table that belongs to a person and holds their data has a decision
 * recorded about what deletion does to it.
 *
 * ## The failure this exists for
 *
 * `presence_sessions` shipped with `last_lat`, `last_lng` and `last_accuracy`
 * — a position, on a per-user row — and the deletion path was not updated. So
 * "delete my account" scrubbed nineteen profile fields and left a trail of
 * where that person had been, on which nights, to within a few metres. Nothing
 * failed. Nothing warned. The deletion path silently stopped being complete the
 * day the model landed, and the only reason it was found is that somebody
 * happened to re-read it weeks later.
 *
 * `account-deletion.test.ts` could not have caught it: it drives the erasure
 * through mocks and asserts what it *does*, which says nothing about a table
 * that was never mentioned. The gap is between the schema and the code, so the
 * guard has to be too.
 *
 * ## Three answers, and every model must give one
 *
 * `SCRUBBED`  — the row survives because somebody else needs it; the personal
 *               columns are nulled. Attendance is the organiser's headcount.
 * `DELETED`   — the row is the person's alone and goes with them.
 * `RETAINED`  — deliberately kept, with the reason written down. This is the
 *               interesting one: it is where a decision gets made rather than
 *               forgotten, and it should be short.
 *
 * A new model with a name, a position or free text on it fails this test until
 * somebody chooses. That is the whole mechanism.
 */
const ROOT = join(__dirname, "..")

/** Columns that are a person, not a fact about the world. */
const PERSONAL =
  /^(latitude|longitude|last_lat|last_lng|last_accuracy|device_info|ip_address|email|phone|name|bio|photos?|body|title|message|content|address|token_hash)$/

/** A row belongs to somebody if it names them. */
const OWNER = /^\s*(user_id|userId|sender_id|reporter_id|liker_id|from_user_id)\s/m

const SCALARS = new Set([
  "String",
  "Float",
  "Int",
  "Boolean",
  "DateTime",
  "Json",
  "Decimal",
  "BigInt",
  "Bytes",
])

type Disposition = "SCRUBBED" | "DELETED" | "RETAINED"

/**
 * The contract. Every entry is a decision somebody made on purpose.
 */
const CONTRACT: Record<string, { how: Disposition; why: string }> = {
  event_check_ins: {
    how: "SCRUBBED",
    why: "Attendance is the organiser's headcount and the co-presence that lets people who met keep talking. None of those readers needs the GPS fix or the device fingerprint.",
  },
  presence_sessions: {
    how: "SCRUBBED",
    why: "Same as check-ins: dwell and occupancy are the organiser's numbers. The position is not.",
  },
  message_requests: {
    how: "SCRUBBED",
    why: "A two-party row, so it stays or the recipient's inbox develops holes. Only the message they SENT is theirs to erase.",
  },
  notifications: {
    how: "DELETED",
    why: "A permanent copy of push previews — counterparty names and message text — outside every control that guards the messages. Nobody else reads them.",
  },
  password_reset_tokens: {
    how: "DELETED",
    why: "A live token for an account that no longer exists is a way back into it.",
  },
  mobile_refresh_tokens: {
    how: "DELETED",
    why: "Sessions belong to the account and end with it.",
  },
  user_oauth_accounts: {
    how: "DELETED",
    why: "The link to the identity provider, and the email it carried.",
  },
  chat_messages: {
    how: "RETAINED",
    why: "The room's conversation is other people's history. A thread that loses half its turns is unreadable for everyone still in it, and the author is already pseudonymous there. Moderation and reports still reach it.",
  },
  audit_logs: {
    how: "RETAINED",
    why: "What an admin did and from where. An accountability record that a subject can erase is not one — and these describe staff actions, not the deleted person's own activity.",
  },
}

function personalModels(): { model: string; columns: string[] }[] {
  const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8")
  const out: { model: string; columns: string[] }[] = []

  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, model, body] = m
    if (!OWNER.test(body)) continue

    const columns = new Set<string>()
    for (const line of body.split("\n")) {
      const f = /^\s*(\w+)\s+(\w+)/.exec(line)
      if (!f) continue
      const [, col, rawType] = f
      const type = rawType.replace(/[?[\]]/g, "")
      // Scalars only: a relation field named `message` is a join, not text.
      if (PERSONAL.test(col) && SCALARS.has(type)) columns.add(col)
    }
    if (columns.size > 0) out.push({ model, columns: [...columns].sort() })
  }
  return out
}

describe("the deletion contract", () => {
  const models = personalModels()

  it("finds the personal models at all", () => {
    /*
     * The control. Every assertion below is satisfied by a detector that has
     * stopped detecting — a schema it cannot parse would report a clean bill of
     * health on a codebase full of unhandled personal data.
     */
    expect(models.length).toBeGreaterThan(5)
    expect(models.map((m) => m.model)).toContain("presence_sessions")
    // And that it does not count relation fields as columns.
    expect(models.map((m) => m.model)).not.toContain("message_reactions")
  })

  it("has a decision recorded for every one", () => {
    const undeclared = models.filter((m) => !CONTRACT[m.model]).map((m) => `${m.model} (${m.columns.join(", ")})`)

    expect({
      undeclared,
      hint: undeclared.length
        ? "This table belongs to a person and holds their data, and account deletion says nothing " +
          "about it. Decide: SCRUBBED (the row survives for somebody else, the personal columns " +
          "are nulled), DELETED (it is theirs alone), or RETAINED (kept on purpose — write down " +
          "why). `presence_sessions` shipped without this and left a map of where somebody had been."
        : "",
    }).toEqual({ undeclared: [], hint: "" })
  })

  it("does the scrubbing and deleting it claims to", () => {
    /*
     * The contract is a promise about code, so it is checked against the code.
     * A `SCRUBBED` entry with no `updateMany` is a decision that was recorded
     * and never implemented, which reads exactly like one that was.
     */
    const route = readFileSync(join(ROOT, "app/api/mobile/account/route.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")

    const broken: string[] = []
    for (const [model, { how }] of Object.entries(CONTRACT)) {
      if (how === "RETAINED") {
        // Retained means the erasure path must NOT touch it.
        if (new RegExp(`db\\.${model}\\.(delete|update)`).test(route)) {
          broken.push(`${model}: declared RETAINED but the deletion path writes it`)
        }
        continue
      }
      const verb = how === "SCRUBBED" ? "updateMany" : "deleteMany"
      if (!new RegExp(`db\\.${model}\\.${verb}\\(`).test(route)) {
        broken.push(`${model}: declared ${how} but no db.${model}.${verb} in the deletion path`)
      }
    }

    expect({ broken, hint: broken.length ? "The contract describes code that is not there." : "" }).toEqual({
      broken: [],
      hint: "",
    })
  })

  it("states a reason for everything it keeps", () => {
    /*
     * A RETAINED entry is the one place a person's data survives on purpose,
     * so the reason is the entire value of the entry — "legacy" or "needed"
     * would pass a presence check and answer nothing.
     *
     * Shape-matched rather than `expect(x, message)`: jest's `expect` takes one
     * argument, and the message-as-second-argument is a Playwright idiom that
     * throws here. The same note appears on two other guards in this suite.
     */
    const unexplained = Object.entries(CONTRACT)
      .filter(([, v]) => v.how === "RETAINED" && v.why.trim().length < 40)
      .map(([model]) => model)

    expect({
      unexplained,
      hint: unexplained.length
        ? "Keeping somebody's data after they asked for it to go is a decision. Write down why, " +
          "in a sentence somebody can disagree with."
        : "",
    }).toEqual({ unexplained: [], hint: "" })
  })
})
