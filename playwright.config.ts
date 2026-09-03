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
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
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
    trace: "retain-on-failure",
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
           * `--disable-dev-shm-usage` because CI containers give `/dev/shm` 64MB
           * and Chromium puts its renderer shared memory there. When it runs
           * out the failure is not a clean error — the browser or the runner
           * dies, and on a hosted runner that surfaces as `exit 143` with no
           * reason attached, which is exactly how this job has been failing.
           *
           * `--disable-gpu` and `--no-sandbox` are the usual headless-CI pair;
           * there is no GPU on a runner and no second user to sandbox from.
           *
           * Local runs are unaffected — the flags are harmless off CI, so this
           * does not create a "works on my machine" gap between the two.
           */
          args: process.env.CI
            ? ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"]
            : [],
        },
      },
    },
  ],
})
