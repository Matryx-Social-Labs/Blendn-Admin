/**
 * The retry that stops a check-in 500ing when two people arrive at once.
 *
 * ## Why this is a unit test and not only an integration one
 *
 * The first attempt at covering this ran two claims against real Postgres and
 * asserted they got different names. It passed against the broken code, and the
 * reason is worth recording: the claims ran **sequentially**, so by the time the
 * second one read the taken names the first had already been written, and no
 * collision was ever produced. A test of a race that does not race is a test of
 * nothing.
 *
 * Here the write is a stub that fails on demand, so the collision is a fact of
 * the fixture rather than a hoped-for interleaving — and the number of attempts
 * is observable, which is what the second case needs and the database cannot
 * show.
 */

jest.mock("@/lib/db", () => ({
  db: {
    // No names taken, so the generator's read is not what makes this pass.
    chat_group_members: { findMany: jest.fn().mockResolvedValue([]) },
  },
}))

import { claimAnonymousName } from "@/lib/anonymous-names"

/**
 * What Prisma raises when a unique index is violated — in BOTH shapes.
 *
 * The documented shape is `meta.target`, and every example uses it. This
 * project's Prisma runs through a driver adapter and emits neither: the fields
 * arrive nested under `meta.driverAdapterError.cause.constraint`, with `target`
 * absent entirely.
 *
 * The first version of this file fabricated only the documented shape, and so
 * passed against a fix that was inert in production — the collision check read
 * `meta.target`, found `undefined`, and rethrew every real collision. The
 * integration test against a real database is what caught it.
 *
 * Both shapes are therefore exercised, and each case below runs twice. A mock
 * that agrees with the documentation and not with the runtime is worse than no
 * mock, because it certifies the wrong thing.
 */
const documented = (fields: string[]) =>
  Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target: fields },
  })

const driverAdapter = (fields: string[]) =>
  Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: {
      modelName: "chat_group_members",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23505",
          kind: "UniqueConstraintViolation",
          constraint: { fields },
        },
      },
    },
  })

const SHAPES = [
  ["documented meta.target", documented] as const,
  ["driver-adapter nested constraint", driverAdapter] as const,
]

describe.each(SHAPES)("claiming a pseudonym when somebody else got there first (%s)", (_label, shape) => {
  const NAME_TAKEN = () => shape(["chat_group_id", "anonymous_name"])
  const ALREADY_A_MEMBER = () => shape(["chat_group_id", "user_id"])

  it("re-rolls and succeeds", async () => {
    /*
     * `generateUniqueAnonymousName` reads the names already in the group and
     * picks a free one; the write is a separate statement, and the unique index
     * is what actually enforces it. So two people checking in at the same moment
     * both read the same name as free, and the second write raises `P2002` —
     * uncaught, that is a 500 on check-in, at the one minute of the night when
     * every attendee performs it.
     */
    const write = jest
      .fn()
      .mockRejectedValueOnce(NAME_TAKEN())
      .mockRejectedValueOnce(NAME_TAKEN())
      .mockResolvedValue("written")

    await expect(claimAnonymousName("group-1", write)).resolves.toBe("written")
    expect(write).toHaveBeenCalledTimes(3)
  })

  it("gives up rather than spinning forever", async () => {
    const write = jest.fn().mockRejectedValue(NAME_TAKEN())
    await expect(claimAnonymousName("group-1", write)).rejects.toMatchObject({ code: "P2002" })
    expect(write).toHaveBeenCalledTimes(5)
  })

  it("does not re-roll a collision on the membership pair", async () => {
    /*
     * The other unique on this table is `(chat_group_id, user_id)` and it means
     * "you are already a member" — a state no amount of re-rolling a name
     * resolves. Retrying it burns five rolls and then throws, which turns an
     * immediate, correct error into a slow one.
     *
     * The assertion is the **call count**, not the rejection: both the correct
     * code and the over-broad version reject with a `P2002`, so asserting only
     * that passes either way. This is why the database could not test it.
     */
    const write = jest.fn().mockRejectedValue(ALREADY_A_MEMBER())
    await expect(claimAnonymousName("group-1", write)).rejects.toMatchObject({ code: "P2002" })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it("drops the preference after it is taken", async () => {
    /*
     * The preferred handle is derived deterministically from `(event, user)`,
     * so re-deriving it after a miss hands back the same taken name every time
     * and burns all five attempts on one collision. Asserted by the names the
     * writes actually receive.
     */
    const write = jest
      .fn()
      .mockRejectedValueOnce(NAME_TAKEN())
      .mockResolvedValue("written")

    await claimAnonymousName("group-1", write, { eventId: "e1", userId: "u1" })

    const [first] = write.mock.calls[0]
    const [second] = write.mock.calls[1]
    expect(second).not.toBe(first)
  })
})
