# Roadmap

Things the marketing site says, or will say, that the product does not do yet.

This file exists because of a decision made during the organiser landing-page
audit: keep the aspirational copy, mark it as roadmap, and **write down what
would have to be true**. Copy promising a feature is a debt. Undocumented copy
promising a feature is a debt nobody is tracking.

Nothing here is scheduled. Pricing is undecided — everything is free for now.

---

## Claimed on the landing page, not built

### Real-time sentiment analysis of the event chatroom

**Partly real.** `lib/sentiment/` classifies feedback-window messages into
polarity plus an issue category (`entry_queue`, `crowding`, facilities, and so
on), and the live event screen surfaces alerts.

**Not real:** it runs over the post-event feedback window, not live during the
event, and there is no "the bar queue is going wrong *right now*, go fix it"
push to the organiser's phone.

What would have to be true: the classifier runs on the live socket stream rather
than a batch sweep; an alert threshold that does not fire on three grumpy
messages; and a delivery path (push, not a dashboard tile someone has to be
looking at).

The argument for this feature does not need inflated statistics, and an earlier
version of `lib/sentiment/taxonomy.ts` carried one — "~45% of venue incidents" —
that appears in neither source it was attributed to. It has been removed. The
honest case is stronger: post-event surveys draw
[5–15% responses](https://www.explori.com/blog/what-is-a-good-post-event-survey-response-rate),
attendees forget [most detail within a day](https://www.surveysensum.com/blog/post-event-feedback-survey),
and [real-time room sentiment remains rare](https://www.aiforevents.co/blog/ai-sentiment-analysis-events)
because every alternative needs cameras, wearables or attendee effort — while
this reads a chatroom people are already using.

### Analytics the dashboard does not have

The forked template's copy promises funnels, cohort retention and revenue
attribution. The dashboard has attendance, RSVPs, check-ins, ratings and
feedback. There is no ticketing and therefore no revenue to attribute.

Either the copy goes or the features do. The copy is cheaper to change.

### Crowd-management positioning

The landing page positions Blendn against crowd mismanagement. What exists today
that supports it: GPS-gated check-in with polygon geofencing, live check-in
counts, capacity warnings, and the sentiment categories above.

What does not: any prediction, any staffing recommendation, any integration with
a venue's own systems.

---

## Product gaps worth knowing about

### Multi-day events — the model landed, two pieces did not

`event_occurrences` exists and check-in is per-day (v0.40.0), so "who came on
Wednesday" is answerable and Tuesday no longer overwrites Monday.

Still event-level, deliberately:

- **Capacity.** `events.current_capacity` counts the whole run. Moving it
  per-day means changing the atomic conditional `UPDATE` that prevents
  overbooking, which is the one piece of concurrency-critical SQL in the
  product. `event_occurrences.capacity` exists and is unread — it is the column
  that work would fill.
- **The feedback window.** The chatroom still closes 24 h after the *last* day,
  so day-one problems surface at the end of the week. This is the one that
  actually costs an organiser something, and it belongs to the chat lifecycle
  sweeper rather than to check-in.

Neither blocks the other. Both are now additive.

### Attendee unmasking

A design round proposed a break-glass flow: a host files a safety report and
sees one attendee's real identity, audited and admin-reviewed.

**Deliberately not built.** It inverts a privacy guarantee the product makes
everywhere else — today real identities never reach a host at all — and deserves
deciding on its own rather than arriving inside a layout import.

### Nominatim usage policy

The geocoder is called from the browser with no identifying `User-Agent`,
against [OSM's usage policy](https://operations.osmfoundation.org/policies/nominatim/)
and a ban risk at volume. Proxying it server-side with caching is small work and
protects the only geocoder the product has.

---

## Business model

Undecided. Everything is free.

The one place this has already shaped a decision: GPS check-in is **mandatory
for all physical events**, with no off toggle. A no-GPS tier is the obvious
thing to gate behind a subscription later, and the geofence model already
separates extent from buffer from per-check-in accuracy, so relaxing it is a
policy change rather than a rewrite.
