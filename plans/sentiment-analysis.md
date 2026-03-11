# Plan: Event Chat Sentiment Analysis (Batch-Only, Low Cost)

## Context

Blendn has anonymous event chats where attendees discuss what's happening at events/venues. Organizers currently have no visibility into crowd mood or operational issues. This feature adds **batch sentiment analysis** — a cron job runs every 5 minutes, sends the batch of recent messages to GPT-4o-mini in a single API call, and stores the results. This avoids per-message API costs entirely.

**Estimated cost: ~$0.50-2/month** (vs $20-100+/month for per-message analysis)

**Existing infrastructure reused:**
- OpenAI API (`OPENAI_API_KEY` already configured)
- Cron pattern from `app/api/cron/event-reminders/route.ts`
- Socket.io from `lib/socket-server.ts` (for dashboard alerts)
- Dashboard analytics patterns from `app/dashboard/actions.ts`

---

## What Gets Detected

Each 5-minute batch analysis produces a snapshot with:

| Detection | Description |
|---|---|
| **Overall sentiment** | Score (-1.0 to +1.0), distribution (% positive/negative/neutral) |
| **Mood trajectory** | Rising, falling, or stable compared to previous window |
| **Issue categories** | With count and urgency per category (see table below) |
| **Trending complaints** | Issues mentioned by 3+ distinct messages in the window |
| **Narrative summary** | 1-2 sentence AI-generated description of crowd mood |
| **Volume anomaly** | Flag if message count is 3x above the event's average rate |

### Issue Categories Detected

| Category | Examples |
|---|---|
| `audio_visual` | "speaker not working", "can't hear", "screen too dark" |
| `queue_crowding` | "queue is very long", "too crowded" |
| `food_beverage` | "food is cold", "no water", "ran out of drinks" |
| `facilities` | "bathroom dirty", "AC not working", "too hot" |
| `safety_security` | "fight broke out", "someone fell", "feel unsafe" |
| `staff_service` | "staff rude", "no one helping" |
| `parking_transport` | "no parking", "uber can't find entrance" |
| `timing_schedule` | "event started late", "schedule is wrong" |
| `venue_navigation` | "can't find stage", "signage unclear" |
| `connectivity` | "no wifi", "phone signal dead" |
| `entertainment_quality` | "DJ is bad", "boring", "not as advertised" |
| `pricing_value` | "overpriced", "not worth it" |
| `positive_highlight` | "amazing vibes", "great music" |

### Real-Time Alerts

| Trigger | Alert Type | Delivery |
|---|---|---|
| `urgency: "critical"` on any message | Critical issue | Socket.io + push to organizer |
| 3+ users, same issue, 10 min window | Trending issue | Socket.io to dashboard |
| Message volume > 3x rolling average | Volume spike | Socket.io to dashboard |
| Sentiment drops below -0.3 rapidly | Mood crash | Socket.io to dashboard |

---

## How It Works

```
Every 5 minutes (cron):
  1. Find all chat_groups with messages in last 5 min
  2. For each active group, fetch messages from last 5 min
  3. Send ALL messages as a single GPT-4o-mini call with structured JSON output
  4. Parse response → store as sentiment_snapshot row
  5. Check for alert conditions → emit Socket.io events if triggered
```

**Why batch is cheap:** Instead of 1 API call per message (500 msgs = 500 calls), we send all 500 messages in 1 call. GPT-4o-mini input is $0.15/M tokens. A 5-min batch of ~50 messages ≈ 2,000 tokens ≈ $0.0003 per batch. Even with 100 active events, that's $0.03/hour or ~$22/month at peak.

---

## Database Schema

### New table: `sentiment_snapshots`

```prisma
model sentiment_snapshots {
  id              String   @id @default(uuid()) @db.Uuid
  chat_group_id   String   @db.Uuid
  event_id        String   @db.Uuid
  window_start    DateTime @db.Timestamptz(6)
  window_end      DateTime @db.Timestamptz(6)
  message_count   Int
  avg_score       Float    // -1.0 to 1.0
  positive_pct    Float    // 0-100
  negative_pct    Float    // 0-100
  neutral_pct     Float    // 0-100
  mood_direction  String   // "rising" | "falling" | "stable"
  top_issues      Json     // [{"category": "food_beverage", "count": 5, "urgency": "high"}]
  trending_topics Json     // ["cold food", "late start"]
  summary         String?  // GPT-generated narrative
  alerts          Json     // [{"type": "trending_issue", "category": "audio_visual", ...}]
  created_at      DateTime @default(now()) @db.Timestamptz(6)

  @@index([chat_group_id, window_start])
  @@index([event_id, window_start])
  @@index([event_id, created_at])
}
```

One table is all we need. No per-message sentiment storage required.

---

## Implementation Phases

### Phase 1: Batch Sentiment Engine

**New files to create:**
- `lib/sentiment/types.ts` — Type definitions (SentimentSnapshot, IssueCategory, AlertType)
- `lib/sentiment/config.ts` — Constants (window size, alert thresholds, GPT model, feature flag)
- `lib/sentiment/analyzer.ts` — Core logic: fetch messages, call GPT-4o-mini, parse structured JSON response, compute aggregates, compare with previous snapshot for mood direction
- `lib/sentiment/index.ts` — Orchestrator: `runSentimentAnalysis()` iterates active chat groups and calls analyzer
- `app/api/cron/sentiment-analysis/route.ts` — Cron endpoint (follows `app/api/cron/event-reminders/route.ts` pattern with `CRON_SECRET` auth)

**Files to modify:**
- `prisma/schema.prisma` — Add `sentiment_snapshots` model

**Run migration:** `npx prisma migrate dev --name add_sentiment_snapshots`

**GPT prompt design** (single call per chat group per window):

```
System: Analyze these anonymous event chat messages. Return JSON with:
- sentiment: {score: -1 to 1, positive_pct, negative_pct, neutral_pct}
- issues: [{category, count, urgency, example_message}]
- trending: [topic strings mentioned by 3+ messages]
- summary: 1-2 sentence crowd mood description

Categories: audio_visual, queue_crowding, food_beverage, facilities,
safety_security, staff_service, parking_transport, timing_schedule,
venue_navigation, connectivity, entertainment_quality, pricing_value, positive_highlight

User: [array of message objects with content and timestamp]
```

### Phase 2: Alerts via Socket.io

**New files:**
- `lib/sentiment/alerts.ts` — Alert condition checks (trending issues, volume spikes, mood crashes, any critical safety issue)

**Files to modify:**
- `lib/socket-server.ts` — Add `sentiment:alert` and `sentiment:snapshot` event types to `ServerToClientEvents`
- `lib/sentiment/index.ts` — After storing snapshot, check alert conditions and emit via Socket.io

### Phase 3: Dashboard API + UI

**New files:**
- `app/dashboard/events/[id]/sentiment/page.tsx` — Sentiment dashboard page
- `app/dashboard/sentiment-actions.ts` — Server actions: get latest snapshot, get time-series, get cross-event overview
- `components/sentiment/mood-gauge.tsx` — Gauge showing current score
- `components/sentiment/sentiment-timeline.tsx` — Line chart of score over time (follows `components/chart-area-interactive.tsx`)
- `components/sentiment/issue-cards.tsx` — Grid of detected issue categories with counts/urgency
- `components/sentiment/alert-panel.tsx` — Active alerts list

**Files to modify:**
- Dashboard navigation — Add "Sentiment" tab/link to event detail page

---

## Key Files to Reference During Implementation

| File | Why |
|---|---|
| `lib/moderation/openai-moderation.ts` | Pattern for OpenAI API calls with fail-open error handling |
| `lib/moderation/index.ts` | Pattern for async analysis orchestration |
| `app/api/cron/event-reminders/route.ts` | Pattern for cron endpoint with CRON_SECRET auth |
| `lib/socket-server.ts` | Where to add new Socket.io event types |
| `app/dashboard/actions.ts` | Pattern for dashboard server actions and DB queries |
| `components/chart-area-interactive.tsx` | Pattern for chart components |
| `prisma/schema.prisma` | Add new model here |

---

## Infrastructure Needs

| Need | Status |
|---|---|
| OpenAI API (GPT-4o-mini) | Already configured |
| Database migration | 1 migration, 1 new table |
| New env vars | Optional: `SENTIMENT_ANALYSIS_ENABLED=true` |
| Cron job | 1 new Railway cron (5-min), same `CRON_SECRET` |
| New packages | None |

---

## Cost Projections

| Scale | Messages/day | Cost/month |
|---|---|---|
| Early (500/day) | 500 | ~$0.50 |
| Growing (5K/day) | 5,000 | ~$5 |
| Scale (50K/day) | 50,000 | ~$22 |

---

## Verification

1. **Phase 1**: Run cron manually via `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/sentiment-analysis` → verify `sentiment_snapshots` rows created with correct analysis
2. **Phase 2**: Check Socket.io events fire when alert conditions met (mock negative messages)
3. **Phase 3**: Visit `/dashboard/events/[id]/sentiment` → verify gauge, timeline, issue cards render with real data
4. **Build**: `npx next build` passes at each phase
