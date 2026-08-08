import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Image optimization
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.amazonaws.com",
      },
      {
        protocol: "https",
        hostname: "**.googleusercontent.com",
      },
      {
        protocol: "https",
        hostname: "**.cloudinary.com",
      },
    ],
  },

  // Disable x-powered-by header
  poweredByHeader: false,

  // Security headers
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            /*
             * HSTS. The dashboard holds a session cookie, so a single plaintext
             * request is a chance to steal it. Two years with preload is the
             * submission requirement.
             *
             * Ignored on plain HTTP, so it is inert in local development.
             */
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            /*
             * CSP, in report-only to begin with.
             *
             * No XSS sink is known -- React escapes by default, the one
             * `dangerouslySetInnerHTML` builds CSS from a static config, and the
             * email templates escape every interpolation. CSP is what makes the
             * *next* one non-catastrophic, which is why it is worth having and
             * why it is not urgent.
             *
             * Report-only because enforcing it blind would break Swagger UI and
             * the chart library on a Friday. `'unsafe-inline'` and
             * `'unsafe-eval'` are here because Next's dev overlay and the
             * Swagger bundle both need them; tightening those is the work that
             * turns this into an enforcing policy, and it needs a report
             * endpoint and a week of data first.
             */
            key: "Content-Security-Policy-Report-Only",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' https: wss:",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
      // CORS for /api/mobile/* is handled per-request in middleware.ts
      // (origin allow-list). Do not add a static wildcard CORS block here -
      // it would apply to every request regardless of origin and override
      // the allow-list logic.
    ];
  },

  // Experimental features
  experimental: {
    // Enable server actions
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

// A production build without SENTRY_AUTH_TOKEN still succeeds, it just ships
// without source maps — which is only discovered later, when a production stack
// trace turns out to be unreadable. Say so at build time.
// NEXT_PHASE is set only during a real build; `next lint` also runs with
// NODE_ENV=production and would otherwise trip this warning.
if (
  process.env.NEXT_PHASE === "phase-production-build" &&
  !process.env.SENTRY_AUTH_TOKEN
) {
  console.warn(
    "[build] SENTRY_AUTH_TOKEN is not set — building without source map upload. " +
      "Production stack traces will stay minified."
  );
}

export default withSentryConfig(nextConfig, {
  // Only upload source maps when SENTRY_AUTH_TOKEN is available
  silent: !process.env.SENTRY_AUTH_TOKEN,
  // Replaces the deprecated `disableLogger: true`, which warned on every build.
  // Strips Sentry's debug logging from the production bundle.
  webpack: { treeshake: { removeDebugLogging: true } },
});
