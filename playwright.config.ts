import { defineConfig, devices } from "@playwright/test"

/**
 * The lane that opens the app.
 *
 * Everything else in this repo tests the product without running it. 2112 unit
 * tests mock `@/lib/db`; 185 integration tests execute real SQL and render no
 * page. Both are worth having and neither can see what a browser sees — three
 * bugs on the curation screens, and two more on the claim funnel, were found by
 * opening a page, and none of them was visible to `tsc`, to jest, or to a real
 * `next build`.
 *
 * ## Serial, against one database
 *
 * The suite signs in as five different roles and reads seeded rows. Parallel
 * workers would share that world and race on it, so this trades wall-clock for
 * a result that means something. Same reasoning as `jest.integration.config.ts`.
 *
 * ## No `webServer` block
 *
 * Deliberate. `next dev` and the server this product actually runs are
 * different programs: `server.ts` is the entry point, it attaches Socket.io and
 * starts four background loops, and it is what production executes. A harness
 * that boots `next dev` would test something nobody ships. The lane starts the
 * real server before calling playwright.
 */
export default defineConfig({
  testDir: "./e2e",
  /*
   * Six sign-ins for the whole run, not one per test.
   *
   * `POST /api/auth/callback/credentials` is limited to 5 per IP per 15 minutes
   * and the suite covers six roles, so per-test sign-in cannot pass. See
   * `e2e/global-setup.ts`.
   */
  globalSetup: "./e2e/global-setup.ts",
  // One worker: the suite reads a shared seeded world.
  workers: 1,
  fullyParallel: false,
  // A failing E2E test is usually a real failure, not a flake — retrying hides
  // the flake instead of reporting it. One retry in CI only, to absorb a cold
  // first compile.
  retries: process.env.CI ? 1 : 0,
  /*
   * No HTML reporter on CI. It accumulates every test's result and attachments
   * in memory to write the report at the end — and on this lane the end is
   * frequently never reached, because the runner is reclaimed mid-suite. The
   * report is then not merely expensive but unreachable: the upload step is
   * skipped along with everything else downstream of the kill.
   *
   * `list` streams to the step log, which is preserved up to the moment of the
   * kill. That is the only channel that survives, so it is the one to spend on.
   */
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    /*
     * Artefacts on failure only.
     *
     * The point is that somebody who did not write the test can see what broke
     * without rerunning it — which is the whole staging-readiness argument.
     */
    /*
     * `on-first-retry` on CI, measured rather than guessed.
     *
     * `retain-on-failure` records a trace for **every** test and throws it away
     * when the test passes, so a green suite pays the full recording cost and
     * keeps none of it. On a 2-core / 7.9GB runner that matters: the suite was
     * observed climbing from 1.8GB to 7.86GB in under two minutes, with load
     * average reaching 46.9 before the host reclaimed the machine.
     *
     * `on-first-retry` records nothing on the first attempt and everything on
     * the retry, which is where a trace is actually read. `retries: 1` on CI
     * means a genuine failure still produces one — the artefact is only lost
     * for a test that fails twice identically, and that one has a trace from
     * the retry anyway.
     *
     * Locally there is no memory pressure and no retry, so the old behaviour
     * stays: a failure keeps its trace on the first run.
     */
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          /*
           * `--disable-gpu` and `--no-sandbox` — the usual headless-CI pair.
           * There is no GPU on a runner and no second user to sandbox from.
           *
           * **`--disable-dev-shm-usage` was here and has been removed**, because
           * the reason given for it was false. The standard advice is that CI
           * containers cap `/dev/shm` at 64MB and Chromium puts renderer shared
           * memory there; the runner was asked, and reported:
           *
           *     tmpfs  3.9G  0  3.9G  0%  /dev/shm
           *
           * So shared memory was never the constraint, and the flag would have
           * pushed Chromium onto disk to solve a problem it does not have. A
           * mitigation carried on a disproven premise is worse than none: it
           * looks like the cause has been addressed.
           */
          args: process.env.CI ? ["--disable-gpu", "--no-sandbox"] : [],
        },
      },
    },
  ],
})
