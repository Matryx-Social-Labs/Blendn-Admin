import { defineRailway, github, project, service } from "railway/iac";

// What railway.json said, plus what Railway holds per environment. Applied by hand per environment with
// `railway config apply` (Railway does not read `.railway/` during deploys). The one file names both, so
// applying it to the wrong environment cannot point a service at the other's branch or domains.
export const partial = "Blendn-Admin";

export default defineRailway((ctx) => {
  const prod = ctx.environment === "production";
  const BlendnAdmin = service("Blendn-Admin", {
    source: github("Matryx-Social-Labs/Blendn-Admin", { branch: prod ? "prod" : "staging", checkSuites: true }),
    build: { buildEnvironment: "V3", builder: "RAILPACK" },
    start: "npm run start",
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
    preDeploy: "npm run railway:predeploy",
    replicas: { "asia-southeast1-eqsg3a": 1 },
    deploy: { ipv6EgressEnabled: true },
    domains: prod ? ["api.blendn.app", "dashboard.blendn.app"] : ["staging-api.blendn.app", "staging-dashboard.blendn.app"],
    networking: { privateNetworkEndpoint: "blendn-admin" },
  });

  return project("Blendn", {
    variables: { managed: false },
    resources: [BlendnAdmin],
  });
});
