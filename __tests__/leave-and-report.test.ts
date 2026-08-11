import { readFileSync } from "fs"
import { join } from "path"

/*
 * Leaving and reporting are one call, and reporting is gated on access.
 *
 * Two separate problems that meet in the same place:
 *
 * 1. Composing "close" and "report" on the client can half-fail. Close
 *    succeeds and report fails → the evidence is behind a thread that has left
 *    both inboxes. Report succeeds and close fails → the person who wanted out
 *    is still in it. Either way the safest-feeling act is the one that loses
 *    the case, which is precisely the shape this design exists to prevent.
 *
 * 2. `POST /messages/:id/report` verified that a message existed and nothing
 *    else, so any authenticated caller who knew or guessed an id could file
 *    against a DM between two strangers.
 *
 * Both are structural — a transaction boundary and a `where` clause. Neither
 * fails loudly if it regresses, so they are asserted at the source.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")

const LEAVE = "app/api/mobile/conversations/[conversationId]/leave/route.ts"
const REPORT = "app/api/mobile/messages/[messageId]/report/route.ts"

describe("leaving and reporting happen together or not at all", () => {
  const src = read(LEAVE)

  it("wraps the close, the block and the report in one transaction", () => {
    expect(src).toContain("db.$transaction")

    // All three writes inside it, on the transaction client rather than `db`.
    const tx = src.slice(src.indexOf("db.$transaction"))
    expect(tx).toContain("tx.private_conversations.updateMany")
    expect(tx).toContain("tx.blocked_users.upsert")
    expect(tx).toMatch(/tx\.(message_reports|user_reports)\.create/)
  })

  it("evicts the socket room OUTSIDE the transaction", () => {
    /*
     * A socket room is not transactional and cannot be rolled back. Inside the
     * transaction, a late failure would leave both people evicted from a
     * conversation that is still open — visible, live, and unreachable.
     */
    // The CALL, not the import at the top of the file.
    const txStart = src.indexOf("db.$transaction")
    const call = src.indexOf("closeConversationRoom(conversationId)")
    expect(call).toBeGreaterThan(txStart)
    expect(src.slice(txStart, call)).not.toContain("closeConversationRoom(conversationId)")
  })

  it("keeps the close idempotent under the transaction", () => {
    // Scoped by `closed_at: null`, so a retry never rewrites who left or when.
    expect(src).toMatch(/where: \{ id: conversationId, closed_at: null \}/)
  })

  it("reports the person when no message is named", () => {
    // `user_reports` needs no conversation, so it is also what stays available
    // after leaving — the report path does not die with the thread.
    expect(src).toContain("tx.user_reports.create")
    expect(src).toContain("reported_id: otherId")
  })

  it("refuses a messageId from a different conversation", () => {
    /*
     * Otherwise the leave route reintroduces the exact hole being closed in the
     * standalone report route: a way to file against any message id you can
     * name. Checked before the transaction, so a bad id is a 404 rather than a
     * rolled-back close.
     */
    expect(src).toMatch(/id: report\.messageId, conversation_id: conversationId/)
    const check = src.indexOf("conversation_id: conversationId")
    expect(check).toBeLessThan(src.indexOf("db.$transaction"))
  })

  it("cancels pending requests both ways when blocking", () => {
    expect(src).toMatch(/sender_id: otherId, recipient_id: authUser\.userId/)
    expect(src).toMatch(/sender_id: authUser\.userId, recipient_id: otherId/)
  })

  it("makes the report optional", () => {
    // "We didn't click" is the common case and has to stay cheap. A required
    // report would make leaving feel like an accusation.
    expect(src).toMatch(/\.optional\(\)/)
    expect(src).toContain("if (report)")
  })

  it("defaults to unmatch rather than block", () => {
    // The softer of the two. Blocking is a bigger claim and should be chosen,
    // never inherited from a missing field.
    expect(src).toMatch(/z\.enum\(\["unmatch", "block"\]\)\.default\("unmatch"\)/)
  })
})

describe("reporting a message requires having been able to see it", () => {
  const src = read(REPORT)

  it("checks group membership for a group message", () => {
    expect(src).toMatch(/chat_group: \{ members: \{ some: \{ user_id: authUser\.userId \} \} \}/)
  })

  it("checks participation for a private message", () => {
    // `[\s\S]` rather than the `s` flag: tsconfig targets below es2018.
    expect(src).toMatch(/user1_id: authUser\.userId[\s\S]*user2_id: authUser\.userId/)
  })

  it("does not filter on closed_at — evidence stays reportable after leaving", () => {
    /*
     * Deliberate, and the whole reason closing is soft rather than hard. Someone
     * who leaves a conversation and only later decides to report it must still
     * be able to. A `closed_at: null` here would quietly undo that.
     */
    const privateBranch = src.slice(src.indexOf("private_messages.findFirst"))
    expect(privateBranch.slice(0, 400)).not.toContain("closed_at")
  })

  it("answers not-found rather than forbidden", () => {
    // A distinct 403 would confirm that a given id exists, which is the probe
    // being closed.
    expect(src).toContain('notFoundResponse("Message not found")')
    expect(src).not.toContain('forbiddenResponse("Message not found")')
  })

  it("no longer accepts a bare existence check", () => {
    // The original shape: `findUnique({ where: { id: messageId } })` with no
    // relationship constraint at all.
    expect(src).not.toMatch(/findUnique\(\{ where: \{ id: messageId \}, select: \{ id: true \} \}\)/)
  })
})
