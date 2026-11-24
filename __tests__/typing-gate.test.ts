import { mayEmitTyping, TYPING_ROOMS_MAX, TYPING_START_MS } from "@/lib/typing-gate"

/**
 * A typing start costs three to five reads, and the app sends one per burst of
 * typing. What a socket sends beyond that is dropped before any read.
 */
const T = 1_900_000_000_000

describe("mayEmitTyping", () => {
  it("lets the app's own pattern through: a start, its stop, and the next burst", () => {
    const s = {}
    expect(mayEmitTyping(s, "chat:a", true, T)).toBe(true)
    expect(mayEmitTyping(s, "chat:a", false, T + 2_500)).toBe(true)
    expect(mayEmitTyping(s, "chat:a", true, T + 3_000)).toBe(true)
  })

  it("drops a start within two seconds of the last one let through, and takes one after", () => {
    const s = {}
    expect(mayEmitTyping(s, "chat:a", true, T)).toBe(true)
    for (let i = 1; i < 50; i++) expect(mayEmitTyping(s, "chat:a", true, T + i)).toBe(false)
    // A dropped start does not move the window.
    expect(mayEmitTyping(s, "chat:a", true, T + TYPING_START_MS)).toBe(true)
  })

  it("a stop ends a start that was let through, once: stops are no way round the gate", () => {
    const s = {}
    expect(mayEmitTyping(s, "chat:a", false, T)).toBe(false)
    expect(mayEmitTyping(s, "chat:a", true, T)).toBe(true)
    expect(mayEmitTyping(s, "chat:a", false, T + 100)).toBe(true)
    expect(mayEmitTyping(s, "chat:a", false, T + 101)).toBe(false)
    // Start, stop, start at once: still one start per two seconds.
    expect(mayEmitTyping(s, "chat:a", true, T + 102)).toBe(false)
  })

  it("is per socket and per room, and remembers a bounded number of rooms", () => {
    const s = {}
    expect(mayEmitTyping(s, "chat:a", true, T)).toBe(true)
    expect(mayEmitTyping(s, "dm:a", true, T)).toBe(true)
    expect(mayEmitTyping({}, "chat:a", true, T)).toBe(true)
    // Past the cap, the oldest is forgotten rather than the map growing.
    for (let i = 0; i < TYPING_ROOMS_MAX; i++) mayEmitTyping(s, `chat:${i}`, true, T + 1)
    expect(mayEmitTyping(s, "chat:a", true, T + 2)).toBe(true)
    expect(mayEmitTyping(s, `chat:${TYPING_ROOMS_MAX - 1}`, true, T + 2)).toBe(false)
  })
})
