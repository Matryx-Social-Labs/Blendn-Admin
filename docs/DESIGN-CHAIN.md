# The design chain

Every dashboard screen goes through this before its implementation files are
touched. It used to be §1 of `TESTING-PLAYBOOK.md`; it is its own document now
because the redesign runs as its own programme — `DASHBOARD-REDESIGN-CHECKLIST.md`
lists every screen and which have been through it — and the testing playbook
starts where this one ends.

**This is a procedure, not a description.** Each step produces a named
**artefact**. No artefact means the step did not happen — that is the whole
mechanism, because "I considered the direction" is not checkable and "here is
the direction I wrote" is.

## The gate

> **You may not edit an implementation file until steps 1, 2 and 3 have each
> produced their artefact for the screen you are about to change.**

Implementation file = anything under `app/`, `components/` or `lib/` that the
screen renders through. Tests, docs and fixtures are not implementation files.

Before the first `Edit`, state the three artefacts. In full, in the response, so
they can be read. Not "ran the chain" — the artefacts themselves.

## The steps

| # | Step | How | **Artefact — what must exist before the next step** |
|---|---|---|---|
| 1 | Operator questions | invoke `ecc dashboard-builder` | The **numbered list of questions in priority order**, plus the **cut list**: which existing panels are going and why. |
| 2 | Direction | invoke `ecc frontend-design-direction` | Five named things: **purpose · audience · tone · the one memorable detail · constraints**. Written out, not referenced. |
| 3 | Build it | invoke `/design-html` | A **file on disk** under `~/.gstack/projects/$SLUG/designs/<screen>-<date>/`, and a **screenshot of it read back**. |
| 4 | Implement | edit | The screen, matching the mockup; `tsc` and the unit suite green. |
| 5 | Look at it | Chrome DevTools or `browse` at 1280 and 768 | Screenshots, read — this is how the dead sticky rail and the half-typed URL crash were found, and no static check could have. |

Testing — the six gates, the specialists, driving the journey and reading the
row back — is `TESTING-PLAYBOOK.md`, and starts once the screen exists.

### Step 1 — questions first, layout never

Start from what the operator needs to know, in priority order, and what they
must be able to do. Every existing panel, column and control is then either an
answer to one of those questions or it is on the cut list. Do not start from
the current layout; treat it as evidence of what the data supports.

### Step 2 when the direction is already set

**This is where it goes wrong, so it is written out rather than left to
judgement.** The dashboard's direction *is* settled — dense, quiet, scannable,
hierarchy from type, no card-in-card, one `HeroMetric`, one gradient element
(`DESIGN_SYSTEM.md`).

That is not permission to skip step 2. **Restate the five, for this screen, in
one line each, and name the one memorable detail — which is per-screen and
cannot be inherited.** On the overview it was the unreached funnel stages drawn
full width in outline. On the applications queue it was the evidence ranking.
On the users screen it was the deleted row as a receipt. On the event form it
was the rail in which the event becomes real. If you cannot name a memorable
detail for the screen you are on, you have not done step 2, and the screen will
come out generic.

Invoke the skill anyway. It costs one call and it is what stops "the direction is
locked" becoming "I skipped the direction".

### Step 3 — the rule, with no judgement in it

An earlier version of this said `/design-html` was "only for a NEW
composition" and told you to "say so rather than skipping it silently". **That
escape clause was used to skip it every single time**, because any change can be
argued not-new-enough. It is replaced with a test that has no opinion in it:

**Run `/design-html` if the change does ANY of:**

- adds, removes or reorders an element on the screen
- changes a layout, a grid, or the order of anything
- changes what an element *means* — a badge's tone, a number's label, an
  action's prominence
- changes more than one file the screen renders through

**Skip it ONLY for:** a copy edit with no layout change, a token value, or a
pure bug fix that alters nothing a person sees.

If you are deciding which side of the line you are on, you are on the run-it
side. The mockup is cheap; going back is not.

Practicalities that have each cost time: `browse` refuses `file://` and
screenshot paths outside the repo or `/private/tmp`, so serve the mockup
(`python3 -m http.server 8765` from its directory) and screenshot to
`/private/tmp`; `sips` cannot crop a tall page reliably — screenshot the
viewport at each scroll position instead; the mockup's tokens are copied from
`app/globals.css`, never invented.

## Say it out loud before implementing

Before the first edit, in the response:

```
Screen: /dashboard/<x>
1 · Questions:  1. …  2. …  3. …    Cutting: … because …
2 · Direction:  purpose … · audience … · tone … · memorable detail … · constraints …
3 · Mockup:     <path>  (or: skipped — copy-only change, no layout effect)
```

Three lines. If any is missing, go back and get it rather than proceeding —
noticing at step 6 that step 2 never happened is noticing after the code is
written, which is the same as not noticing.
