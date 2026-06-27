# shadcn UI Migration — Self Check-in Todo

**Goal**: Replace all remaining raw/custom UI in `blendn-admin` dashboard with shadcn/ui components, consistently. This is a standalone effort separate from [BACKLOG.md](BACKLOG.md), though several BACKLOG items (3.1, 3.5, 3.6, 3.7, 4.1) overlap and should be resolved *as part of* this migration rather than twice.

Resume here each session: check off completed items, update "Current State" if it's gone stale, and re-grep before starting a new item (file line numbers will drift).

---

**Scope expanded 2026-06-27**: originally this covered the dashboard only; the goal is now project-wide — every page/component in `blendn-admin` (`app/**`, `components/**`, excluding `components/ui/*` which is shadcn's own generated code and excluding the separate `blendn/` mobile app, which is React Native and not shadcn-applicable). Full repo grep sweep done; remaining surface area is small and enumerated below.

**Theme switch 2026-06-27 (separate, larger change)**: beyond just "use shadcn components," the user asked to drop the custom branded dark theme entirely (orange `#f05423`/violet `#865693`/rose `#be5c71`, radial-gradient mesh backgrounds, glassmorphism `.brand-*` utility classes) and switch to shadcn's **stock default neutral theme** — the standard oklch-based light/dark palette shadcn generates out of the box, same as shadcn's own dashboard-01 block. This is a visual identity change, not just a component-compliance one. See the new section below for what changed and the current state of this effort.

## Current State (as of 2026-06-27, post project-wide sweep)

- shadcn is already configured: `components.json` — style `new-york`, baseColor `neutral`, cssVariables on, icons via `lucide`.
- Installed primitives in `components/ui/`: avatar, badge, breadcrumb, button, calendar, card, chart, checkbox, drawer, dropdown-menu, form, input, label, popover, select, separator, sheet, sidebar, skeleton, sonner, switch, table, tabs, textarea, toggle, toggle-group, tooltip.
- **Missing primitives** (not yet `npx shadcn add`-ed): `dialog`, `alert-dialog`, `command`, `pagination`, `scroll-area`, `slider`. `progress` and `radio-group` were installed during the `event-form.tsx` split (2026-06-27). Install on-demand per task, not all upfront.
- `components/credential-modal.tsx` is already done right — uses `Sheet` from shadcn. Use it as the reference pattern for "this is what good looks like here."

### Project-wide sweep results (2026-06-27)

Ran `grep -rln "<button\b\|<input\b\|<select\b\|<textarea\b"` and a hex-color/overlay-pattern sweep across all of `app/**` and `components/**` (excluding `components/ui/*`, 52 non-ui `.tsx` files total). This is the **complete remaining surface area** — everything not listed here is already shadcn-clean as of this sweep:

| File | Issue | Notes |
|---|---|---|
| `components/event-messaging.tsx:330` | raw `<button>` (quick-template chip) | Missed in the earlier pass — that session only converted the tab switcher + edit/delete buttons, not this one. |
| `components/event-form/media-section.tsx:77` | raw `<button>` (dnd-kit drag handle) | Left raw intentionally during the event-form split "to avoid disturbing drag listeners" — worth attempting a `Button variant="ghost"` conversion since Radix `Button` forwards refs/props fine for dnd-kit's `{...attributes}{...listeners}` spread; just needs care. |
| `components/event-form/location-section.tsx:148` | raw `<input type="range">` (check-in radius) | No `slider` primitive was installed during the event-form split. Needs `npx shadcn add slider` + conversion to `Slider`. |
| `components/event-form/timezone-select.tsx:58` | manual `absolute z-50` dropdown, not `Popover` | Combobox pattern, closes via blur/click-outside hack. `popover` primitive already installed. |
| `components/location-picker.tsx:281` | manual `absolute z-50` dropdown, not `Popover` | Same combobox pattern as timezone-select. Note: this file's `#6366f1` hex values (lines 160-161, 247-248) are Leaflet map-marker config, **not** a design-token issue — leave those alone, they're a mapping library API, not Tailwind/CSS. |
| `app/page.tsx`, `app/login/page.tsx`, `app/dashboard/layout.tsx`, `app/dashboard/chatrooms/page.tsx`, `app/dashboard/organisers/page.tsx`, `app/dashboard/venue-owners/page.tsx`, `app/dashboard/users/users-table.tsx`, `app/dashboard/events/page.tsx`, `components/role-users-table.tsx`, `components/nav-user.tsx`, `components/nav-main.tsx`, `components/site-header.tsx`, `components/dashboard/report-overview.tsx`, `components/dashboard/export-menu.tsx` | hardcoded hex colors (`#F05423`, `#d84a1d`, `#865693`, `#BE5C71`, `#090909`, etc.) instead of theme tokens | This is BACKLOG 3.5, the design-tokens pass — 14 files, not 8 as originally scoped; the earlier count undercounted before the full sweep. |

No raw `<select>` or `<textarea>` found anywhere outside `components/ui/*`. `components/ui/sidebar.tsx`'s internal raw button is shadcn-generated — leave it.

### Resolved in prior sessions (kept for history, see Todo section below for full detail)

- Duplicate events-table implementations consolidated; `app/dashboard/events-table.tsx` and `components/data-table.tsx` deleted (dead code).
- `components/event-form.tsx` split into `components/event-form/*` + converted to shadcn `Form`.
- Inconsistent container spacing (BACKLOG 3.6) — still open, scheduled last (see Todo).

---

## Todo

- [ ] **Install missing shadcn primitives** likely needed for the rest of this list: `dialog`, `alert-dialog`, `command`, `pagination`, `progress`, `radio-group`, `scroll-area`. Install on-demand per item below rather than all upfront, to avoid unused installs.

- [x] **`components/location-picker.tsx`** — replaced the 1 raw `<button>` (search-suggestion row) with shadcn `Button` (`variant="ghost"`, custom `className` to preserve left-aligned non-bold row look). Verified: tsc clean, lint clean.
  - **Follow-up found during modal audit (2026-06-27, not yet fixed)**: the dropdown *container* around that button (~line 281) is still a raw `absolute z-50` div, not a `Popover`. Same issue found in `components/event-form.tsx`'s `TimezoneSelect` (~lines 158-209) — both are search-suggestion comboboxes that should anchor via shadcn `Popover` instead of manual `absolute`/`z-50` positioning + an `onBlur`+`setTimeout(150ms)` close hack. Needs the `popover` primitive (already installed) wired in for both. Not done yet — see audit item below.

- [x] **`components/event-messaging.tsx`** — replaced hand-rolled tab buttons (~lines 401-424) with shadcn `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`, wired to the existing `tab` state via `value`/`onValueChange`. Edit/delete icon buttons (~245-259) were already shadcn `Button`s, just missing labels — added `aria-label="Edit message"` / `aria-label="Delete message"`. Verified: tsc clean, lint clean, build succeeds.

- [x] **`components/chat-feed.tsx`** — converted all 3 raw `<button>`s to shadcn `Button`: the Messages/Members tab toggle (`variant="ghost"`, `h-auto rounded-none` to preserve underline-tab look), the refresh button (already `Button`, just added missing `aria-label="Refresh"`), and the `RestrictedMemberCard` expand/collapse toggle (`variant="ghost"`, added `aria-label`). Verified: tsc clean, lint clean.
  - Note: this file still hand-rolls its own tab switcher (Messages/Members) the same way `event-messaging.tsx` used to — it wasn't converted to the shadcn `Tabs` component itself, only the underlying button element was swapped. **Revisit**: consider converting this to real `Tabs` too for consistency with the messaging page, since the visual tab pattern is the same class of problem as 3.7, just not flagged at that file originally.

- [x] **`components/event-form.tsx`** — converted and split (2026-06-27). The file already used react-hook-form, so fields were rewired through shadcn `Form`/`FormField`/`FormItem`/`FormLabel`/`FormControl`/`FormMessage` for consistent validation-error display. Split 1,248 lines into `components/event-form/`: `schema.ts`, `form-section.tsx`, `timezone-select.tsx`, `upload.ts`, and section components `basic-info-section.tsx`, `location-section.tsx`, `schedule-section.tsx`, `capacity-settings-section.tsx`, `cover-image-section.tsx`, `media-section.tsx`, `advanced-section.tsx` — `event-form.tsx` itself is now a ~160-line orchestrator. Added `RadioGroup` (primary-category selection) — installed `progress` + `radio-group` primitives for this. Upload progress (BACKLOG 3.8) was added, not skipped: the Tigris/S3 PUT was switched from `fetch()` to `XMLHttpRequest` inside `upload.ts` to get real `onprogress` events, rendered via shadcn `Progress` with percentage on both cover-image and gallery uploads.
  - Left intentionally raw: the check-in radius `<input type="range">` (no slider primitive installed/in scope) and the dnd-kit drag-handle button (to avoid disturbing drag listeners).
  - **Needs a human pass**: manually exercise a cover-image/gallery upload to confirm the progress bar animates smoothly (depends on `Content-Length` being computable for the `File` object — should be fine for normal uploads, just not yet eyeballed in a browser).

- [x] **Consolidate `events-table.tsx` (x2)** — resolved (2026-06-27). Investigation found `app/dashboard/events/page.tsx` only ever imported `components/events-table.tsx`; `app/dashboard/events-table.tsx` (500 lines) and `components/data-table.tsx` (807 lines) had **zero importers anywhere** — both were dead. `app/dashboard/events-table.tsx` looked feature-richer (row-selection, column-visibility, page-size picker) but its `Event` interface didn't match what `/api/events` actually returns — stale scaffolding, never wired to real handlers, not a true superset. Decision: kept `components/events-table.tsx` as the sole `EventsTable`, deleted both `app/dashboard/events-table.tsx` and `components/data-table.tsx` outright (repurposing `data-table.tsx` would've been more work than extending the winner). Small clean addition: replaced a meaningless "0 of Y row(s) selected" footer (no selection UI existed) with a "Page X of Y" indicator next to the existing Previous/Next buttons. `@dnd-kit/*` deps were NOT removed — `event-form.tsx`'s media section still uses them for drag-reorder.

- [x] **Empty states** on `app/dashboard/organisers/page.tsx` and `app/dashboard/venue-owners/page.tsx` — added a dashed-border empty-state card above each `RoleUsersTable`, shown when the fetched dataset is empty: "No organisers found" (`IconUserPlus`) and "No venue owners found" (`IconBuildingStore`), copy matching each page's tone. Search bar / "Generate Credentials" / table chrome untouched. Verified: tsc clean, lint clean.

- [x] **Loading skeletons** on `app/dashboard/users/page.tsx` — page does server-side `Promise.all` fetching with no existing client loading state, so added `app/dashboard/users/loading.tsx` (idiomatic App Router pattern) using the existing `Skeleton` component: 4 skeleton stat cards + a skeleton table (header + 6 rows × 9 cols matching `users-table.tsx`'s real column count), styled to match the page's actual classes. Verified: tsc clean, lint clean.

- [x] **Audit for other custom modal-like components** — done (2026-06-27). Found exactly 2, both search-suggestion comboboxes, neither using `Popover`:
  - `components/event-form.tsx` `TimezoneSelect` (~lines 158-209): `Input` + manual `absolute z-50` dropdown, closes via `onBlur` + 150ms `setTimeout` hack. Recommend `Popover` (or `Popover` + `Command` later for real keyboard-navigable autocomplete).
  - `components/location-picker.tsx` (~line 281): same shape/pattern. See note above — this survived the location-picker "done" pass because only the row *button inside* the dropdown was in scope that session, not the dropdown container itself.
  - Not flagged: `role-users-table.tsx` (uses already-correct `CredentialModal`/`Sheet`), `event-form.tsx`'s `FormSection` collapsible (disclosure pattern, not a modal — candidate for `Collapsible`/`Accordion` separately, different primitive class, out of scope here).
  - **Remaining work**: convert both comboboxes to `Popover` (primitive already installed, no new install needed).

- [x] **`components/event-messaging.tsx:330`** — converted the quick-template chip `<button>` to shadcn `Button variant="outline" size="sm"`, with `className="rounded-full text-left text-xs"` to preserve the pill look the variant doesn't cover.

- [x] **`components/event-form/media-section.tsx:77`** — converted the dnd-kit drag-handle `<button>` to `Button variant="ghost" size="icon"` (`className="size-auto cursor-grab touch-none p-1"` to restore the compact handle sizing). Confirmed safe: `components/ui/button.tsx` renders a plain native `<button>` when not using `asChild` (no Radix `Slot`/extra DOM wrapper), so `{...attributes}{...listeners}` from dnd-kit's `useSortable` spreads through cleanly — drag still works.

- [x] **`components/event-form/location-section.tsx:148`** — installed `slider` primitive, converted the check-in-radius `<input type="range">` to shadcn `Slider` with `value={[field.value ?? 100]}` / `onValueChange={(vals) => field.onChange(vals[0])}` (array-based Radix API). `FormLabel` live-value and "10 m"/"5 000 m" bounds left untouched.

- [x] **`components/event-form/timezone-select.tsx`** + **`components/location-picker.tsx`** — both converted to shadcn `Popover`/`PopoverTrigger asChild`/`PopoverContent`, `open` state wired directly to Popover's `open`/`onOpenChange`, blur/setTimeout hacks removed, suggestion buttons switched `onMouseDown`→`onClick` (no longer racing a blur timer). `PopoverContent` uses `align="start"` + `w-[var(--radix-popover-trigger-width)] p-0` to match input width, and `onOpenAutoFocus={(e) => e.preventDefault()}` on both so focus stays in the input instead of jumping into the panel (matches prior UX). Behavioral upgrade: outside-click/Escape dismissal is now native/reliable instead of racing a 150-200ms timeout. Left `location-picker.tsx`'s unrelated `#6366f1` Leaflet marker colors untouched as scoped.

- [x] **Design tokens pass** — done. Added to `app/globals.css` (`@theme inline`, `:root`, `.dark`): `--brand` (#f05423), `--brand-hover` (#d84a1d), `--brand-violet` (#865693), `--brand-rose` (#be5c71). `#090909` got **no new token** — it was identical to the existing `--background` value, so usages were repointed to `bg-background`/`var(--background)` instead of inventing a redundant one. All 14 files swept; two had zero matches for these specific brand hexes and were correctly left alone (`users-table.tsx` only has unrelated hexes like `#7c3aed`/`#2563eb`; `export-menu.tsx` only has unrelated `#0d0d10`) — not stale grep counts, just out of scope. `location-picker.tsx` correctly excluded. Tailwind-class usages (`bg-[#F05423]` etc.) became `bg-brand`/`text-brand-violet` via Tailwind v4's automatic `--color-*` utility generation (same pattern already used for `--primary`); raw CSS-string usages in `report-overview.tsx` (recharts `color`/`stroke` props) became `"var(--brand)"` etc., matching the existing `var(--primary)` convention in `chart-area-interactive.tsx`.
  - Side note: while in `organisers/page.tsx` and `venue-owners/page.tsx`, the agent found the empty-state blocks added in an earlier session also had one `text-[#F05423]` each — converted those to `text-brand` too since in scope, nothing else in those blocks touched.

- [ ] **Spacing consistency pass** — last one remaining. Normalize container padding across dashboard pages (`px-4 lg:px-6` vs `px-6` vs `p-5` vs `p-4` vs `px-6 py-6`) to one scale. Not started. Note: now that the brand theme is gone (see below), worth doing this pass and a final visual pass together rather than separately.

---

## Theme switch: custom brand → shadcn default neutral (2026-06-27, session 4)

User showed a screenshot of `/dashboard` (the investor/ops overview page) and asked to redo the entire UI with shadcn defaults — confirmed via clarifying questions: (1) switch to shadcn's stock default theme rather than just keep the branded look and ensure compliance, and (2) cover **all** dashboard pages, not just this one.

**What changed in `app/globals.css`**: replaced the entire custom theme (hex-based brand colors `#f05423`/`#865693`/`#be5c71`, `--background: #090909`, radial-gradient body mesh, `.brand-mesh`/`.brand-surface`/`.brand-muted-panel`/`.brand-gradient-text`/`.brand-chip`/`.brand-wordmark::before` utility classes, `--brand`/`--brand-hover`/`--brand-violet`/`--brand-rose` variables) with shadcn's stock oklch-based neutral theme — the same `:root`/`.dark` variable set shadcn's CLI generates by default (light theme white/near-black, dark theme `oklch(0.145 0 0)` background, neutral chart-1..5 palette). `app/layout.tsx` already forces `className="dark"` on `<html>`, unchanged — app is still always-dark, just neutral-dark instead of branded-dark now.

**This was a breaking change for every page** that referenced the deleted brand classes/variables or relied on hardcoded `bg-white/[0.0N]`/`border-white/NN`/`text-white/NN`/`bg-black/NN` opacity utilities (which assumed the old near-black background) or arbitrary custom radii (`rounded-[1.4rem]` through `rounded-[2rem]`). Ran 6 parallel cleanup passes, one per area, each told to replace these with theme-aware tokens (`bg-card`, `bg-background`, `bg-muted`, `bg-accent`, `text-foreground`, `text-muted-foreground`, `border-border`/default `border`, `bg-primary`/`text-primary-foreground`) and standard radii (`rounded-lg`/`rounded-xl`/`rounded-full`), with `components/location-picker.tsx`'s `#6366f1` Leaflet marker color explicitly excluded everywhere (mapping-library API value, not a design token):

- **Shell** (`app/dashboard/layout.tsx`, `app-sidebar.tsx`, `site-header.tsx`, `nav-main.tsx`, `nav-user.tsx`, `brand-logo.tsx`) — done. `nav-secondary.tsx`/`nav-documents.tsx` needed no changes (already plain).
- **Dashboard home** (`components/dashboard/report-overview.tsx`, `export-menu.tsx`) — done. Recharts trend colors switched from `var(--brand*)` to `var(--chart-1/2/3/4)`. Also fixed the one inconsistency flagged earlier (header preview tiles weren't wrapped in `Card`) while in there.
- **Events** (`app/dashboard/events/**`, `components/events-table.tsx`, `components/event-form/**`, `event-editor.tsx`, `event-list.tsx`, `location-picker.tsx`, `event-messaging.tsx`) — only `events/page.tsx` and `events-table.tsx` needed changes; everything under `event-form/**` was already theme-token-clean from the earlier split.
- **People** (`organisers/**`, `venue-owners/**`, `users/**`, `role-users-table.tsx`, `credential-modal.tsx`, `user-events-table.tsx`) — done, including fixing the empty-state icon color (`text-brand` → `text-muted-foreground`, since `--brand` no longer exists) and matching `users/loading.tsx`'s skeleton styling to the restyled real page.
- **Chat/Moderation** (`chatrooms/**`, `chat-feed.tsx`, `moderation-queue.tsx`) — only `chatrooms/page.tsx` needed changes; `chat-feed.tsx`/`moderation-queue.tsx` were already theme-token-clean.
- **Public/login** (`app/page.tsx`, `app/login/page.tsx`) — done.

**Post-merge fixes**: removed an unused `useRef` import left behind in `timezone-select.tsx` from the earlier Popover conversion (flagged independently by 4 of the 6 parallel agents as "pre-existing, out of scope" — it was real and just needed a one-line fix, done after all agents landed). One agent (public/login) flagged `brand-logo.tsx` as out-of-scope-but-broken and spawned a background task chip for it — turned out the shell agent had already fixed that file; the chip is stale, safe to dismiss if the user sees it.

**Verification**: `npx tsc --noEmit`, `npm run lint`, `npm test` (40/40), and a clean `npm run build` (after `rm -rf .next`) all pass. Final repo-wide grep for any leftover `brand-mesh|brand-surface|brand-muted-panel|brand-gradient-text|brand-chip|brand-wordmark|bg-brand|text-brand|var(--brand` or hardcoded brand hex (`#F05423`, `#d84a1d`, `#865693`, `#BE5C71`) across `app/**`/`components/**` returned **zero matches** — fully swept.

**Not verified**: actual rendered appearance in a browser — no browser tool was available in that session to screenshot the result. The dev server was confirmed to boot and serve `/login`, `/`, and all dashboard routes with 200s under this change, but nobody has eyeballed it yet. **Do this first next session**: spin up `npm run dev`, log in, and visually check at least `/dashboard`, `/dashboard/events`, `/dashboard/organisers`, `/dashboard/chatrooms` against what shadcn's dashboard-01 block looks like, before considering this done.

---

## Working notes / decisions made so far

- Scope is `blendn-admin` dashboard UI only — not the mobile app (`blendn/`), not API routes.
- Don't fix `components/ui/sidebar.tsx` — it's shadcn-generated, raw elements inside it are expected/upstream.
- When a shadcn-conversion item overlaps with an existing BACKLOG.md item (noted inline above), resolve both in the same edit — don't create two passes over the same file.
- **2026-06-27 session 1**: ran 5 todo items in parallel (location-picker, event-messaging, chat-feed, organisers/venue-owners empty states, users loading skeleton). All verified clean together after.
- **2026-06-27 session 2**: ran 3 more in parallel — modal audit, events-table consolidation (deleted `app/dashboard/events-table.tsx` + `components/data-table.tsx`, kept `components/events-table.tsx`), and the big `event-form.tsx` conversion+split. Ran full verification (`tsc`/`lint`/`test`/`build`) again afterward since all three touched the repo concurrently — all clean, no regressions.
- `chat-feed.tsx`'s Messages/Members tab toggle still hand-rolls its own active-tab logic with plain buttons (just shadcn `Button` now, not real `Tabs`) — still an open follow-up, low priority.
- **2026-06-27 session 3**: project-wide sweep across all of `app/**`/`components/**` (excluding `components/ui/*` and the separate `blendn/` mobile app) — found everything remaining (no more was hiding). Ran 4 more items in parallel: remaining raw buttons (event-messaging chip, media-section drag handle), Slider conversion for check-in radius, both Popover conversions, and the 14-file design-tokens pass. Verified all together after (`tsc`/`lint`/`test`/`build`) — clean. One build attempt hit a transient stale-`.next`-cache `PageNotFoundError` unrelated to any code change; clearing `.next` and rebuilding fixed it, two agents independently hit and correctly diagnosed the same flake.
- **Current state**: only the spacing-consistency pass remains from the original list, plus the low-priority `chat-feed.tsx` Tabs follow-up. The project-wide sweep found no other custom UI outside `components/ui/*` as of 2026-06-27 — if scope expands further (e.g. new pages added later), re-run the grep sweep documented above before assuming this file is exhaustive.
