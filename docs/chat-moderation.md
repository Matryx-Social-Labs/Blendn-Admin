# Chat Moderation System

## Overview

Every message sent in event group chat goes through a multi-layer moderation pipeline. The system is designed to **never block the user experience** — messages are saved and delivered instantly via Socket.io, and moderation runs asynchronously in the background (fire-and-forget). The only exception is spam detection, which runs synchronously before the message is saved.

**Pipeline order:**

```
User sends message
  │
  ├─ [SYNC] Spam check → blocks message if spam detected
  │
  ├─ Message saved to DB + emitted via Socket.io
  │
  └─ [ASYNC - fire and forget]
       ├─ 1. Keyword filter (~1ms)
       ├─ 2. OpenAI text moderation (50-200ms)
       └─ 3. OpenAI image moderation (500-1500ms, images/gifs only)
            │
            └─ Action: hide / flag / mark clean
```

If any layer returns `hide`, the pipeline **stops early** — no further checks run.

---

## Layer 1: Spam Detector

**When:** Synchronous, runs BEFORE the message is saved to the database.
**Source file:** `lib/moderation/spam-detector.ts`
**Config:** `lib/moderation/config.ts`

This is the only layer that can **prevent a message from being created at all**.

### Checks

| Check | Threshold | Action | Config constant |
|---|---|---|---|
| Burst rate | 5+ messages in 10 seconds | **Hide** (blocked) | `SPAM_BURST_LIMIT`, `SPAM_BURST_WINDOW_MS` |
| Excessive links | 3+ URLs in one message | **Hide** (blocked) | `MAX_LINKS_PER_MESSAGE` |
| Duplicate content | 80% trigram similarity with recent message | **Flag** (saved but flagged) | `SPAM_DUPLICATE_SIMILARITY` |

### How it works

- Maintains an **in-memory store** keyed by `userId:chatGroupId`
- Tracks each user's recent messages with timestamps
- History entries expire after 5 minutes (`SPAM_HISTORY_TTL_MS`)
- Store is bounded to 5,000 entries max (`SPAM_MAX_ENTRIES`) with periodic eviction

### Test examples

| Message | Context | Result |
|---|---|---|
| "hello" sent 5 times in 8 seconds | Same user, same chat | **Blocked** — burst rate exceeded |
| "Check https://a.com https://b.com https://c.com" | Any context | **Blocked** — 3 links exceeds max of 2 |
| "buy my tickets now!!!" | User sent same message 10 seconds ago | **Flagged** — duplicate content (similarity 1.0 > 0.8) |
| "buy my tickets right now!" | User sent "buy my tickets now!!!" 10 seconds ago | **Flagged** — near-duplicate (trigram similarity > 0.8) |
| "Great event!" then "Love the music!" | Same user, 5 seconds apart | **Clean** — different content, under burst limit |
| "hello" | No recent messages from user | **Clean** |

---

## Layer 2: Keyword Filter

**When:** Asynchronous, first check after message is saved.
**Source file:** `lib/moderation/keyword-filter.ts`

Exact-match against curated wordlists covering **9 languages** with leetspeak normalization.

### Languages covered

| Language | Script | Example keywords |
|---|---|---|
| English | Latin | nigger, faggot, retard, cunt, kike, spic, chink, tranny, wetback |
| Hindi | Devanagari | मादरचोद, भोसडीके, चूतिया, गांड, लौड़ा, रंडी, बहनचोद |
| Hindi | Transliterated | madarchod, bhosadike, chutiya, gaand, lauda, randi, behenchod |
| Tamil | Tamil + Latin | ஒத்த, தேவடியா, thevadiya, otha, punda, sunni |
| Telugu | Telugu + Latin | లంజ, దెంగు, lanja, dengu, pooku, modda |
| Kannada | Kannada + Latin | ಸೂಳೆ, sule, magane, tunne |
| Malayalam | Malayalam + Latin | തായോളി, thayoli, kunna, myre |
| Bengali | Bengali + Latin | চোদ, মাগি, chod, magi, khanki |
| Marathi | Latin | zavadya, aighala, chinal |
| Gujarati | Gujarati + Latin | ભોસડી, ghando, bhosadi |

**Abbreviations** (exact word match only): `mc`, `bc`, `bsdk`, `mc bc`

### Normalization (evasion prevention)

Before matching, the message is normalized:

| Evasion technique | Raw input | Normalized | Caught? |
|---|---|---|---|
| Leetspeak | `n!gg3r` | `nigger` | Yes |
| Leetspeak | `ch0d` | `chod` | Yes |
| Leetspeak | `f@g` | `fag` | Yes |
| Separator insertion | `f.a.g.g.o.t` | `faggot` | Yes |
| Separator insertion | `c-h-u-t-i-y-a` | `chutiya` | Yes |
| Mixed case | `RETARD` | `retard` | Yes |
| Underscore spacing | `r_e_t_a_r_d` | `retard` | Yes |

### Confidence scoring

```
confidence = 0.7 + (number_of_matched_keywords × 0.1)
```

| Matches | Confidence | Action |
|---|---|---|
| 1 keyword | 0.8 | **Flag** for review (message stays visible) |
| 2 keywords | 0.9 | **Auto-hide** + flag (confidence >= 0.85) |
| 3+ keywords | 1.0 | **Auto-hide** + flag |

### Test examples

| Message | Matched keywords | Confidence | Result |
|---|---|---|---|
| "you're such a chutiya retard" | chutiya, retard | 0.9 | **Hidden** + flagged |
| "this event is bc terrible" | bc | 0.8 | **Flagged** (visible) |
| "madarchod bhosadike" | madarchod, bhosadike | 0.9 | **Hidden** + flagged |
| "what a fag event" | fag | 0.8 | **Flagged** (visible) |
| "n!gg3r go home" | nigger (via leetspeak) | 0.8 | **Flagged** (visible) |
| "bsdk kya kar rahe ho" | bsdk | 0.8 | **Flagged** (visible) |
| "this event sucks" | none | — | **Passes** (no keywords matched) |
| "the food is terrible" | none | — | **Passes** |
| "mc bc chutiya" | mc, bc, chutiya | 1.0 | **Hidden** + flagged |

---

## Layer 3: OpenAI Text Moderation

**When:** Asynchronous, runs after keyword filter (if keyword filter didn't already hide).
**Source file:** `lib/moderation/openai-moderation.ts`
**Model:** `omni-moderation-latest`
**Fails open:** If the API is down or key is missing, the message is treated as clean.

### Categories scored

OpenAI returns a confidence score (0.0 to 1.0) for each category:

| Category | What it detects |
|---|---|
| `hate` | Hate speech targeting protected groups |
| `hate/threatening` | Hate speech with threats of violence |
| `harassment` | Bullying, intimidation, targeted abuse |
| `harassment/threatening` | Harassment with threats |
| `self-harm` | Content promoting self-harm |
| `self-harm/intent` | Expressing intent to self-harm |
| `self-harm/instructions` | Instructions for self-harm |
| `sexual` | Sexual content |
| `sexual/minors` | Sexual content involving minors |
| `violence` | Violent content |
| `violence/graphic` | Graphic depictions of violence |

### Thresholds

| Highest category score | Action | Config constant |
|---|---|---|
| >= 0.85 | **Auto-hide** + flag | `AUTO_HIDE_THRESHOLD` |
| 0.50 - 0.84 | **Flag** for review (message stays visible) | `FLAG_THRESHOLD` |
| < 0.50 | **Clean** | — |

### Test examples

| Message | Likely top category | Estimated score | Result |
|---|---|---|---|
| "I want to kill everyone at this event" | violence | ~0.92 | **Hidden** + flagged |
| "Go kill yourself" | self-harm/intent | ~0.90 | **Hidden** + flagged |
| "She's so hot, I want to see her naked" | sexual | ~0.70 | **Flagged** (visible) |
| "I hate this crowd, bunch of losers" | harassment | ~0.55 | **Flagged** (visible) |
| "this DJ should be beaten up" | violence | ~0.65 | **Flagged** (visible) |
| "I'll find you and hurt you" | harassment/threatening | ~0.88 | **Hidden** + flagged |
| "The food was terrible" | all categories | < 0.1 | **Clean** |
| "The music is so loud it's killing me" | violence | ~0.12 | **Clean** (figurative) |
| "This event is boring" | all categories | < 0.1 | **Clean** |
| "Where's the nearest bar?" | all categories | < 0.1 | **Clean** |

> **Note:** Scores above are approximations. Actual scores depend on OpenAI's model and may vary. Test with real API calls to verify behavior.

---

## Layer 4: OpenAI Image Moderation

**When:** Asynchronous, only runs on messages with `type: "image"` or `type: "gif"` that have a `mediaUrl`.
**Source file:** `lib/moderation/openai-moderation.ts`
**Model:** `omni-moderation-latest`

Same categories and thresholds as text moderation, applied to the image content.

| Image content | Likely category | Result |
|---|---|---|
| Explicit nudity | sexual ~0.95 | **Hidden** + flagged |
| Suggestive/revealing clothing | sexual ~0.60 | **Flagged** (visible) |
| Gore or graphic violence | violence/graphic ~0.90 | **Hidden** + flagged |
| Hate symbols (swastika, etc.) | hate ~0.80 | **Flagged** (visible) |
| Normal event photo | all < 0.1 | **Clean** |
| Food photo | all < 0.1 | **Clean** |

---

## Actions Taken

### Auto-hide (confidence >= 0.85)

1. Message `moderation_status` set to `"hidden"`
2. Message soft-deleted (`deleted_at` set to current time)
3. Socket.io emits `chat:messageHidden` to all clients in the chat room — message disappears from everyone's screen
4. A `moderation_flags` record is created for admin review
5. Auto-mute check runs (see below)

**Source:** `lib/moderation/actions.ts` → `hideMessage()`

### Flag for review (confidence 0.50 - 0.84)

1. Message `moderation_status` set to `"flagged"`
2. A `moderation_flags` record is created with categories and confidence scores
3. Message **stays visible** to all users
4. Admin can review on the dashboard and approve (keep) or reject (hide)

**Source:** `lib/moderation/actions.ts` → `flagForReview()`

### Mark clean (all checks passed)

1. Message `moderation_status` set to `"clean"`
2. No further action

**Source:** `lib/moderation/actions.ts` → `markClean()`

### Auto-mute (repeated violations)

If a user accumulates **3 or more hidden messages within 1 hour** in the same chat group, they are automatically muted:

1. `chat_group_members.status` set to `"muted"`
2. User can no longer send messages in that chat group
3. Muted users receive a 403 error when attempting to send

**Config:** `AUTO_MUTE_HIDDEN_COUNT = 3`, `AUTO_MUTE_WINDOW_MS = 60 minutes`

**Source:** `lib/moderation/actions.ts` → `checkAndAutoMute()`

---

## Moderation Flag Record

Each flag stored in the `moderation_flags` table contains:

| Field | Description |
|---|---|
| `message_id` | The flagged message |
| `chat_group_id` | Which chat group |
| `user_id` | Who sent it |
| `source` | `auto_keyword`, `auto_text`, `auto_image`, `auto_spam`, `user_report`, `manual` |
| `status` | `pending` (awaiting review), `approved` (kept), `rejected` (hidden by admin) |
| `categories` | JSON object with category names and confidence scores |
| `confidence` | Highest confidence score |
| `auto_action` | `hidden` or `none` |
| `reviewed_by` | Admin who reviewed (null until reviewed) |
| `reviewed_at` | When reviewed |
| `review_notes` | Admin notes |

---

## Admin Review (Dashboard)

**Endpoints:**

- `GET /api/events/{eventId}/chat/moderation` — List flagged messages
  - Query params: `status` (pending/approved/rejected/all), `page`, `limit`
  - Returns flags with message content, categories, confidence, source

- `PATCH /api/events/{eventId}/chat/moderation/{flagId}` — Review a flag
  - Body: `{ "action": "approve" | "reject", "notes": "optional reason" }`
  - Approve = keep the message visible
  - Reject = hide the message

**Dashboard page:** `/dashboard/events/[id]/messaging`

---

## Configuration Reference

All thresholds are in `lib/moderation/config.ts`:

```typescript
// Confidence thresholds
AUTO_HIDE_THRESHOLD = 0.85     // Auto-hide if confidence >= this
FLAG_THRESHOLD = 0.5           // Flag for review if confidence >= this

// Spam detection
SPAM_BURST_LIMIT = 5           // Max messages in burst window
SPAM_BURST_WINDOW_MS = 10_000  // 10 second window
SPAM_DUPLICATE_SIMILARITY = 0.8 // Trigram similarity threshold
SPAM_HISTORY_TTL_MS = 300_000  // 5 minute history retention
SPAM_MAX_ENTRIES = 5_000       // Max in-memory history entries
MAX_LINKS_PER_MESSAGE = 2      // Max URLs allowed per message

// Auto-mute
AUTO_MUTE_HIDDEN_COUNT = 3     // Hidden messages to trigger mute
AUTO_MUTE_WINDOW_MS = 3_600_000 // 1 hour window for auto-mute
```

---

## Testing Guide

### Prerequisites

- App running locally (`npm run dev`)
- `OPENAI_API_KEY` set in `.env` (required for layers 3 and 4)
- A test event with an active chat group
- A test user checked into the event

### Test 1: Keyword filter

Send these messages in event chat and verify the expected outcomes:

```
Message: "this is a chutiya event"
Expected: Flagged (1 keyword, confidence 0.8)
Verify: moderation_status = "flagged", moderation_flags record with source = "auto_keyword"

Message: "madarchod bhosadike"
Expected: Hidden (2 keywords, confidence 0.9)
Verify: moderation_status = "hidden", deleted_at set, moderation_flags record

Message: "bsdk kya scene hai"
Expected: Flagged (1 abbreviation, confidence 0.8)
Verify: moderation_status = "flagged"

Message: "n!gg3r"
Expected: Flagged (leetspeak → nigger, confidence 0.8)
Verify: moderation_status = "flagged"

Message: "hey everyone, great event!"
Expected: Clean
Verify: moderation_status = "clean", no moderation_flags record
```

### Test 2: OpenAI text moderation

```
Message: "I want to stab everyone here"
Expected: Hidden (violence score likely > 0.85)
Verify: moderation_status = "hidden", source = "auto_text"

Message: "you're all worthless idiots"
Expected: Flagged (harassment score likely 0.5-0.84)
Verify: moderation_status = "flagged", source = "auto_text"

Message: "the sound system is broken"
Expected: Clean
Verify: moderation_status = "clean"
```

### Test 3: Spam detection

```
Send "hello" 5 times rapidly (within 10 seconds) in the same chat
Expected: First 4 messages save successfully, 5th message is blocked with 429 status

Send "Check out https://a.com https://b.com https://c.com"
Expected: Message blocked (3 links > max 2)

Send "buy tickets now" then "buy tickets now" again within 10 seconds
Expected: Second message is flagged as duplicate
```

### Test 4: Auto-mute

```
1. Send 3 messages that trigger auto-hide (e.g., messages with 2+ keywords each)
2. All 3 within 1 hour in the same chat group
3. After the 3rd hidden message, try sending another message
Expected: 403 Forbidden response — user is muted
Verify: chat_group_members.status = "muted" for that user
```

### Test 5: Admin review

```
1. Send a message that gets flagged (not hidden)
2. Go to dashboard → Events → [event] → Messaging
3. View the flagged message in the moderation queue
4. Click "Approve" → message stays visible, flag status = "approved"
5. Or click "Reject" → message is hidden, flag status = "rejected"
```

### Database queries for verification

```sql
-- Check moderation status of recent messages
SELECT id, content, moderation_status, deleted_at, created_at
FROM chat_messages
WHERE chat_group_id = '<group-id>'
ORDER BY created_at DESC
LIMIT 20;

-- Check moderation flags
SELECT mf.id, mf.source, mf.status, mf.categories, mf.confidence, mf.auto_action,
       cm.content
FROM moderation_flags mf
JOIN chat_messages cm ON cm.id = mf.message_id
WHERE mf.chat_group_id = '<group-id>'
ORDER BY mf.created_at DESC
LIMIT 20;

-- Check if a user is muted
SELECT user_id, status, banned_at
FROM chat_group_members
WHERE chat_group_id = '<group-id>'
AND user_id = '<user-id>';
```

---

## What Moderation Does NOT Catch

The system is designed for **safety**, not sentiment. These will pass through as clean:

- Complaints: "the food is terrible", "worst event ever", "speaker is broken"
- Sarcasm: "wow, great event management"
- Passive aggression: "thanks for nothing"
- General negativity: "this is boring", "waste of money"
- Coded slang not in the wordlist
- New or uncommon profanity variations

For crowd mood tracking and issue detection, see the planned [Sentiment Analysis](../plans/sentiment-analysis.md) feature.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│                 Chat POST Request                │
│    /api/mobile/events/[eventId]/chat             │
│    /api/mobile/chat/groups/[groupId]/messages     │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
              ┌────────────────┐
              │  Spam Detector  │ ◄── SYNC (before save)
              │  (in-memory)   │
              └───────┬────────┘
                      │
              ┌───────┴───────┐
              │               │
          [spam]          [clean]
              │               │
          Block msg      Save message to DB
          Return 429     Emit via Socket.io
                              │
                              ▼
                    ┌──────────────────┐
                    │  ASYNC PIPELINE   │ ◄── fire-and-forget
                    │  (never throws)  │
                    └────────┬─────────┘
                             │
                    ┌────────┴────────┐
                    │  Keyword Filter  │
                    │  (~1ms, sync)    │
                    └────────┬────────┘
                             │
                    ┌────────┴────────┐
                    │                 │
                [match]          [no match]
                    │                 │
                    ▼                 ▼
             hide or flag    ┌────────────────┐
             (early exit)    │  OpenAI Text    │
                             │  (50-200ms)     │
                             └────────┬────────┘
                                      │
                             ┌────────┴────────┐
                             │                 │
                          [match]          [no match]
                             │                 │
                             ▼                 ▼
                      hide or flag    ┌────────────────┐
                      (early exit)    │  OpenAI Image   │
                                      │  (if applicable)│
                                      │  (500-1500ms)   │
                                      └────────┬────────┘
                                               │
                                      ┌────────┴────────┐
                                      │                 │
                                   [match]          [no match]
                                      │                 │
                                      ▼                 ▼
                               hide or flag       markClean()
                                      │
                                      ▼
                            ┌──────────────────┐
                            │ checkAndAutoMute  │
                            │ (if message was   │
                            │  hidden)          │
                            └──────────────────┘
```
