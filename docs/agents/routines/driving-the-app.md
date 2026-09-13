# Routine: driving the mobile app

Two devices, both on the staging bundle: one iOS simulator, one Android
emulator — so two-person journeys (match, reveal, DM, room) can be driven for
real. The product owner's rule: use one iOS and one Android rather than one
simulator twice.

## Connecting the app to staging
`.env.development.local` (gitignored) wins the Expo dotenv precedence over
`.env.local`. Set it to staging and restart Metro `--clear`:

    EXPO_PUBLIC_API_BASE_URL=https://staging-api.blendn.app
    EXPO_PUBLIC_APP_ENV=staging

Proof you are off local: the local `:3100` server (if running) receives **zero**
app requests after the repoint — only its own sweeper heartbeats. On boot the
app logs "No stored token" / "user not authenticated" because the local JWT is
invalid against staging; sign in with the **staging** seed password.

Metro reverse tunnels: staging is a public URL, so Android needs only
`adb reverse tcp:8081 tcp:8081` (Metro), not the API port.

## iOS simulator
- Device UDID and Maestro invocation are machine-specific; discover with
  `xcrun simctl list devices booted`.
- **Maestro 2.x on the iOS 26 simulator is a tracked incompatibility**
  (mobile-dev-inc/maestro #3137): the XCUITest driver crashes the app every few
  sessions and sometimes fails to start at all. Mitigation: batch steps into one
  flow; relaunch the app with the dev-client URL
  `xcrun simctl openurl <udid> "exp+blendn://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"`.
  `blendn://` is NOT registered in the iOS build.
- Warm a route with a curl before driving it: dev-mode first-hit compiles exceed
  the client's 15s timeout and surface as a false "taking too long".

## Android emulator
- Start it as its own background task (no `setsid` on macOS; a child of a
  stopped shell dies): `emulator -avd <name> -no-snapshot-load -gpu
  swiftshader_indirect -no-boot-anim`. Grant `SYSTEM_ALERT_WINDOW` via appops.
- `adb shell input text` in 3-4 char chunks with short sleeps or characters drop.
- Tap coordinates are in the **real** resolution (e.g. 1080×2400), not the
  scaled screenshot — scale up before tapping.
- **GPS never delivers a fix on either emulator image** (Play or non-Play): the
  fused provider ignores `geo fix`. **Check-in needs a real device (SCRUM-112).**
  Everything after check-in works on the emulator; for the checked-in state,
  place the `event_check_ins` + `presence_sessions` rows as a fixture.

## The static map on Android
`react-native-maps` needs `android.config.googleMaps.apiKey` in the manifest;
without it the Location-card map is blank on Android (iOS uses Apple Maps).
Supplied via `app.config.js` — takes effect on a native rebuild only (SCRUM-125).

## Screenshots
`xcrun simctl io <udid> screenshot out.png` (iOS) /
`adb -s <serial> exec-out screencap -p > out.png` (Android). Downscale large
Android shots with `sips -Z 1000` before reading.
