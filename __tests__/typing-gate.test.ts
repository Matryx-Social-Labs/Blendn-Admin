import { mayEmitTyping, TYPING_ROOMS_MAX, TYPING_START_MS } from "@/lib/typing-gate"

/**
 * A typing start costs three to five reads, and the app sends one per burst of
 * typing. What a socket sends beyond that is dropped before any read.
 */
const T = 1_900_000_000_000
const A = "abcdefab-0000-4000-8000-00000000000a"
const room = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`

describe("mayEmitTyping", () => {
  it("lets the app's own pattern through: a start, its stop, and the next burst", () => {
    const s = {}
    expect(mayEmitTyping(s, "chat", A, true, T)).toBe(true)
    expect(mayEmitTyping(s, "chat", A, false, T + 2_500)).toBe(true)
    expect(mayEmitTyping(s, "chat", A, true, T + 3_000)).toBe(true)
  })

  it("drops a start within two seconds of the last one let through, and takes one after", () => {
    const s = {}
    expect(mayEmitTyping(s, "chat", A, true, T)).toBe(true)
    for (let i = 1; i < 50; i++) expect(mayEmitTyping(s, "chat", A, true, T + i)).toBe(false)
    // A dropped start does not move the window.
    expect(mayEmitTyping(s, "chat", A, true, T + TYPING_START_MS)).toBe(true)
  })

  it("a stop ends a start that was let through, once: stops are no way round the gate", () => {
    const s = {}
    expect(mayEmitTyping(s, "chat", A, false, T)).toBe(false)
    expect(mayEmitTyping(s, "chat", A, true, T)).toBe(true)
    expect(mayEmitTyping(s, "chat", A, false, T + 100)).toBe(true)
    expect(mayEmitTyping(s, "chat", A, false, T + 101)).toBe(false)
    // Start, stop, start at once: still one start per two seconds.
    expect(mayEmitTyping(s, "chat", A, true, T + 102)).toBe(false)
  })

  it("is per socket and per room, and remembers a bounded number of rooms", () => {
    const s = {}
    expect(mayEmitTyping(s, "chat", A, true, T)).toBe(true)
    expect(mayEmitTyping(s, "conversation", A, true, T)).toBe(true)
    expect(mayEmitTyping({}, "chat", A, true, T)).toBe(true)
    // Past the cap, the oldest is forgotten rather than the map growing.
    for (let i = 0; i < TYPING_ROOMS_MAX; i++) mayEmitTyping(s, "chat", room(i), true, T + 1)
    expect(mayEmitTyping(s, "chat", A, true, T + 2)).toBe(true)
    expect(mayEmitTyping(s, "chat", room(TYPING_ROOMS_MAX - 1), true, T + 2)).toBe(false)
  })
})

it("drops an id that is not a UUID, without throwing: it comes straight off the wire", () => {
  const s = {}
  for (const id of [{ toString: 1 }, {}, null, undefined, 7, ["a"], "a", "x".repeat(1_000_000)]) {
    expect(mayEmitTyping(s, "chat", id, true, T)).toBe(false)
  }
})

it("one room is one key however its id is spelled", () => {
  const s = {}
  expect(mayEmitTyping(s, "chat", A, true, T)).toBe(true)
  expect(mayEmitTyping(s, "chat", A.toUpperCase(), true, T + 1)).toBe(false)
})
