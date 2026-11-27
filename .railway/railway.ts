import { defineRailway, github, project, service } from "railway/iac";

// The web service's deploy settings per environment (railway.json until Railway's 2026-12-01 cutoff). Applied by
// hand per environment with `railway config apply` (Railway does not read `.railway/` during deploys). The one file
// names both, so applying it to the wrong environment cannot point a service at the other's branch or domains.
export const partial = "Blendn-Admin";

export default defineRailway((ctx) => {
  const prod = ctx.environment === "production";
  const BlendnAdmin = service("Blendn-Admin", {
    source: github("Matryx-Social-Labs/Blendn-Admin", { branch: prod ? "prod" : "staging", checkSuites: true }),
    build: { buildEnvironment: "V3", builder: "RAILPACK" },
    start: "npm run start",
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
    // The test accounts are staging's; `db:migrate` also exists on a prod branch older than `railway:predeploy`.
    preDeploy: prod ? "npm run db:migrate" : "npm run railway:predeploy",
    replicas: { "asia-southeast1-eqsg3a": 1 },
    // Restart on failure is Railway's default and is not stored; naming it here plans a change forever.
    // Teardown: Railway's defaults are 0 and 0, so every deploy SIGKILLed the old process at once and
    // server.ts's shutdown (flush, pool close, io.close, its own 10 s force-exit) never ran. Draining 15 s
    // covers that 10 s; overlap 0 keeps one process, so sweepers never run twice and no socket is split.
    deploy: { restartPolicyMaxRetries: 3, ipv6EgressEnabled: prod, overlapSeconds: 0, drainingSeconds: 15 },
    domains: prod ? ["api.blendn.app", "dashboard.blendn.app"] : ["staging-api.blendn.app", "staging-dashboard.blendn.app"],
    networking: { privateNetworkEndpoint: "blendn-admin" },
  });

  return project("Blendn", {
    variables: { managed: false },
    resources: [BlendnAdmin],
  });
});
