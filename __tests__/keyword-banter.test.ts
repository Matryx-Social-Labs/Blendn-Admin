import { CHAT_KEYWORDS, checkKeywords } from "@/lib/moderation/keyword-filter"

/*
 * Banter between friends at an event is the product (SCRUM-1167).
 *
 * A whole-word keyword hit hides the line and counts toward the room's
 * three-strike mute. Words that are also ordinary speech -- "chod" (leave it),
 * "shala" (brother-in-law), "magane" (Kannada: O son), "boli", "BC" (because,
 * British Columbia), "MC" (the host) -- go to a human as a flag instead, and
 * never hide. Real abuse still hides.
 */

const BENIGN = [
  "chod yaar, let's go",
  "chod na, it's fine",
  "bc the MC is late",
  "the mc is killing it tonight",
  "BC and Ontario both launch soon",
  "moving to Vancouver BC next month",
  "boli maga, where are you",
  "football at 6",
  "imagine the tunnel at Majestic",
  "shala, you came after all",
  "magane, bega baa",
  "arey harami, you finished my fries",
  "kamina dost, always late",
  "kamine log, save me a seat",
  "Sunni Muslim, love chai",
  "otha, the same shirt as me",
  "poori and chai at the stall",
  "gudda hike tomorrow morning",
  "magi noodles after the gig",
  "bal bal bach gaye",
  "tunne the drums down a bit",
  "naanu koodi barthini",
  "Supriya Sule spoke at the panel",
  "magna cum laude, finally",
  "ghando chhe tu, love you",
  "gandu hudga, he plays football",
  "हरामी, फिर से लेट",
  "अबे कमीने, रुक",
  "साले, कहाँ है तू",
  "ये कुत्ते बहुत प्यारे हैं",
]

const ABUSIVE = [
  "you retard",
  "shut up faggot",
  "tu chutiya hai",
  "oye madarchod",
  "bhenchod chup kar",
  "benchod kya kar raha hai",
  "behnchod nikal",
  "bhosdike idhar aa",
  "bhosdk",
  "bhosdiwale",
  "maderchod saala",
  "kya chutiyapa hai",
  "gaandu kahin ka",
  "lavde ke baal",
  "lawda le",
  "bhadwa hai tu",
  "bsdk",
  "randi",
  "तू एक चूतिया है",
  "मादरचोद",
  "बहनचोद",
  "वो रंडी है",
  "தேவடியா",
  "లంజకొడుకు",
  "lanja",
  "ಸೂಳೆ",
  "thayoli",
  "খানকি",
  "চোদ",
  "zavadya",
]

it("is the 60 lines the task names, 30 each", () => {
  expect([BENIGN.length, ABUSIVE.length]).toEqual([30, 30])
})

it.each(BENIGN)("never hides %p (null or a flag for a human)", (line) => {
  expect(checkKeywords(line)?.action ?? "null").not.toBe("hide")
})

it.each(ABUSIVE)("hides %p", (line) => {
  expect(checkKeywords(line)?.action).toBe("hide")
})

it("flags an ordinary word that is also abuse, naming it, at the confidence that never hides", () => {
  expect(checkKeywords("chod yaar")).toMatchObject({ action: "flag", source: "keyword", confidence: 0.5, matched: ["chod"] })
})

it("matches a review-only word as a whole word only, never inside another", () => {
  for (const line of ["football at 6", "imagine that", "the tunnel", "symbolic", "otherwise"]) {
    expect(checkKeywords(line)).toBeNull()
  }
})

it("knows nothing of mc or bc any more", () => {
  expect(checkKeywords("mc bc")).toBeNull()
})

it("a real slur beside banter still hides, and names only the slur", () => {
  expect(checkKeywords("chod yaar, bhenchod")).toMatchObject({ action: "hide", matched: ["bhenchod"] })
})

it("every keyword is one word, and matches itself as that word", () => {
  expect([...CHAT_KEYWORDS].filter((k) => !checkKeywords(k)?.matched?.includes(k) || /\s/.test(k))).toEqual([])
})

it("review words are matched as words (leetspeak folded); a slur with separators between its letters is flagged", () => {
  expect(checkKeywords("c.h.o.d yaar")).toBeNull()
  expect(checkKeywords("sh@la")).toMatchObject({ action: "flag", matched: ["shala"] })
  expect(checkKeywords("b.h.e.n.c.h.o.d")).toMatchObject({ action: "flag", matched: ["bhenchod"] })
})

it.each(["madar chod", "behen chod", "bhen chod", "teri maa ki madar chod"])("a review word glued back onto the word before it is the slur it spells: %p hides", (line) => {
  expect(checkKeywords(line)?.action).toBe("hide")
})

it("only the word before it: two ordinary words never make a slur, and a word after a review word stays itself", () => {
  expect(checkKeywords("chod do")?.action).toBe("flag")
  expect(checkKeywords("my re-entry, and then Di said hi")?.action).not.toBe("hide")
})
