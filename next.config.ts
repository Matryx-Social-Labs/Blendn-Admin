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
if (process.env.NODE_ENV === "production" && !process.env.SENTRY_AUTH_TOKEN) {
  console.warn(
    "[build] SENTRY_AUTH_TOKEN is not set — building without source map upload. " +
      "Production stack traces will stay minified."
  );
}

export default withSentryConfig(nextConfig, {
  // Only upload source maps when SENTRY_AUTH_TOKEN is available
  silent: !process.env.SENTRY_AUTH_TOKEN,
  disableLogger: true,
});
