# Reference: environment

**Secrets are never written here.** Passwords, DB URLs, JWT secrets and tokens
are referenced by *how to retrieve them*, not by value. Emails and ids are
identifiers, not secrets.

## Targets (staging only — never production)
| Surface | URL |
|---|---|
| Dashboard | `https://staging-dashboard.blendn.app` |
| Mobile API + sockets | `https://staging-api.blendn.app` |

Production (`dashboard.blendn.app` / `api.blendn.app`) is **out of bounds** for
writes; read-only, and only when explicitly required.

## Seed accounts (staging)
One account per dashboard role, written on **every staging deploy** by
`scripts/test-accounts.ts` (the Railway pre-deploy step). The password is the
`SEED_PASSWORD` variable on the staging `Blendn-Admin` service — read it with
`railway variables --environment staging --service Blendn-Admin`, never copy it
into a file. Change the variable to rotate it; Railway redeploys. To re-seed
staging from a laptop, `RAILWAY_ENVIRONMENT_NAME=staging` must be set as well —
the seed refuses any database that is not staging or `localhost`.

| Email | Role | Persona |
|---|---|---|
| `admin@blendn.app` | app_admin | Priya Menon |
| `organizer@blendn.app` | organizer | Arjun Rao, Nightshift Collective |
| `venue.owner@blendn.app` | venue_owner | Fatima Sheikh, Indiranagar Hospitality Group |
| `sponsor@blendn.app` | sponsor | Meera Iyer, Blue Tokai Coffee Roasters |

The personas were renamed in place from `priya.menon@`, `arjun.rao@`,
`fatima.sheikh@` and `meera.iyer@` — same ids, same history. Also seeded by
`seed-qa.ts`, same password: `sagar.kishore@`, `hemanth.ramesh@`,
`likhith.gowda@` (named admins), `daniel.weber@` (organiser with no org — the
negative control), and the attendees `ananya.b@`, `rohan.d@`, `sneha.p@`, ….

Resolve ids against the staging DB rather than hardcoding (staging ids are
`cmt…`, distinct from local).

## Staging database (read freely; write through the API)
The public connection string is a Railway variable, not a constant:

    railway variables --environment staging --service Postgres --json  → DATABASE_PUBLIC_URL

Query it through the local Docker Postgres client so the URL never lands in
shell history in plaintext — store it in a chmod-600 file and pass by env:

    docker exec -e PGURL="$(cat <secure-file>)" blendn-pg17 sh -c 'psql "$PGURL" -Atc "…"'

Prefer product writes (sign in, drive the flow). Direct writes only for fixtures
the UI cannot make (e.g. a check-in the emulator's dead GPS blocks).

## Local Docker Postgres (integration tests only)
- Container `blendn-pg17`, `postgresql://postgres:postgres@localhost:55433/blendn_test`.
- **Kept persistent**: anonymous data volume + `restart=unless-stopped` (survives
  reboot). Do not `docker rm` it without a dump.
- Integration tests need `MOBILE_JWT_SECRET` (≥32 chars) and `NEXTAUTH_SECRET`
  (≥32 chars) in the env; the config is in `jest.integration.config.ts`.
- Build the schema with `db:migrate`, **not** `db:push` — push omits three CHECK
  constraints that exist in every deployed environment.

## Token / scratch files

`npm run -s qa bootstrap | sq | token | world | probe | lock` (`scripts/qa.ts`)
does all of the below: the DB URL in `~/.blendn-qa/pgurl` (600, not `/tmp`,
which macOS purges), read-only queries through the repo's `pg`, cached and
refreshed mobile tokens (the sign-in limit counts successes), and socket probes.
See `../TEST-PLAN.md`.

Short-lived access tokens (15 min) and the secure DB-URL file live under a
gitignored scratch dir (this session used `/tmp/mflows/`). Re-sign-in via
`POST /api/mobile/auth/signin` when a token expires; vary `X-Forwarded-For` to
avoid the per-network sign-in rate limit.

## Ports
- Metro: `8081` (Android needs `adb reverse tcp:8081 tcp:8081`).
- Local dev server (if used for itests / a local drive): `3100`.

## The Android emulator — use `Blendn_A34`, not `Blendn_GApis`

**API 34 is the supported target. API 36.1 is not usable.** The section below
records what API 36 cost and why, because the symptoms all look like something
else (a slow GPU, slow typing) and the real causes are invisible unless you time
a primitive.

On API 34 (`system-images;android-34;google_apis;arm64-v8a`), out of the box:
`ro.dalvik.vm.enable_uffd_gc=false`, Settings cold start 2.2 s, `uiautomator
dump` 3.1 s, 20 chars 1.3 s — no workaround needed, and Maestro's driver starts.

### The recipe that works

1. **A release build, not the dev client.** `cd android && SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew assembleRelease` with **JDK 21** (`/opt/homebrew/opt/openjdk@21`; JDK 26 fails the React Native Gradle plugin). The 14 MB unminified dev bundle is what makes the dev client ANR under input; the release APK embeds a minified bundle and needs no Metro at all. `.env.local` + `.env` both point at staging, so the URL bakes in correctly — verify with `strings assets/index.android.bundle | grep staging-api`.
2. **Keep Maestro's driver installed.** Maestro's own install fails silently here and it uninstalls the driver after each run, so the *next* run dies on `deviceInfo`. Extract `maestro-app.apk` and `maestro-server.apk` from `maestro-client.jar` and install them once.
3. **Reap the zombie driver before every run.** A killed run leaves a defunct `[.mobile.maestro]` process that blocks the next driver start — the symptom is `Device server died during 'deviceInfo' ... UNAVAILABLE`. `adb shell am force-stop dev.mobile.maestro` clears it. This is the single highest-value line in `/tmp/mflows/mshot.sh`.
4. **Watch host load.** An iOS simulator + its XCUITest runner + Metro + a 6-core emulator put a 10-core M1 Pro at load average 20 with 3.6M pageouts, and the guest ANRs because its `system_server` cannot get CPU. Shut down whichever platform you are not driving. Disabling guest bloat helps too (`pm disable-user --user 0 com.google.android.googlequicksearchbox` was burning 59%).
5. **Do not `launchApp` mid-suite.** Restarting the app and immediately tapping is what triggers most ANRs; drive a warm app.

`input tap x y` is frequently dropped by React Native — use `input swipe x y x y 120`, a tap with dwell. For *text*, prefer Maestro's `inputText` over `adb shell input text`: adb's key injection outruns RN's controlled `TextInput` and drops all but the first character or two.

## Why API 36.1 (`Blendn_GApis`) was abandoned

Measured 2026-09-14. The AVD looked GPU-bound and was not; two unrelated causes
made it ~56× slow, and both are invisible unless you time a primitive.

| | before | after |
|---|---|---|
| `adb shell input text` (20 chars) | 11.3 s | 0.187 s |
| `uiautomator dump` (28-node tree) | 30.8 s | 3.5 s |
| Settings cold start | 20 s timeout | 1.3 s |

**`enable_uffd_gc` is the big one.** With it on, *every* process fails to start
in time — `userfaultfd: MOVE ioctl seems unsupported: Connection timed out`, then
`ANR … failed to complete startup`. That is also why Maestro's Android driver
dies: its process ANRs before the gRPC server binds, so `inputText` blocks until
the 120 s deadline and reports a timeout that looks like slow typing.

It must be set **before zygote starts** — setting it post-boot does nothing — and
`persist.device_config.*` is re-synced from device_config at every boot unless
sync is disabled first. Once, then restart the emulator from the host:

```bash
adb root                                   # google_apis (non-Play) only
adb shell device_config set_sync_disabled_for_tests persistent
adb shell device_config put runtime_native_boot enable_uffd_gc false
adb shell setprop persist.device_config.runtime_native_boot.enable_uffd_gc false
adb unroot                                 # Maestro's driver breaks under root adbd
```

Verify: `adb shell getprop persist.device_config.runtime_native_boot.enable_uffd_gc`
→ `false`. `-gpu host` is correct; surfaceflinger at 245% was a symptom of the
uffd thrash, not the renderer.

`config.ini` is now `hw.ramSize=6144`, `hw.cpu.ncore=6`, `vm.heapSize=512M`
(was 4096/4/228M — 195 MB free of 4 GB, swapping, with the RN dev app resident).

**Driving it.** Maestro 2.10's Android driver still ANRs at startup on this image
even after both fixes, so drive Android with `adb` directly. A bare
`input tap x y` is frequently dropped by React Native — use
`input swipe x y x y 120`, a tap with dwell. Typing is still the weak point: the
14 MB unminified dev bundle leaves the JS thread slow enough that rapid input
ANRs the app, so type in small chunks and read the field back.
