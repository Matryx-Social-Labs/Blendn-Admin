import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { getToken } from "next-auth/jwt"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"
import { canAccessDashboard } from "@/lib/rbac"
import type { user_role } from "@prisma/client"

const ALLOWED_ORIGINS = [
  "https://api.blendn.app",
  "https://dashboard.blendn.app",
  "https://blendn.app",
  process.env.NEXTAUTH_URL,
].filter(Boolean) as string[]

/**
 * Two names for one deployment.
 *
 * `api.blendn.app` is a poor URL for a human to log into, so the dashboard gets
 * `dashboard.blendn.app`. Both point at the same Railway service — splitting
 * into two would double the deploy surface and force a decision about which one
 * owns Socket.io, which both surfaces use.
 *
 * Serving each surface only on its own host keeps that from being cosmetic: a
 * dashboard page on the API host, or a mobile endpoint on the dashboard host,
 * is a routing accident rather than something anyone meant.
 *
 * Unset means "no host split configured", which is the correct behaviour for
 * local development and for any environment that has not been given a second
 * domain — everything serves everywhere, exactly as before.
 */
const DASHBOARD_HOST = process.env.DASHBOARD_HOST ?? null
const API_HOST = process.env.API_HOST ?? null

function wrongHost(pathname: string, host: string | null): boolean {
  if (!host || !DASHBOARD_HOST || !API_HOST) return false
  const bare = host.split(":")[0]
  if (pathname.startsWith("/dashboard")) return bare === API_HOST
  if (pathname.startsWith("/api/mobile")) return bare === DASHBOARD_HOST
  return false
}

function getCorsHeaders(origin: string | null): Record<string, string> {
  const baseHeaders = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  }

  // Native mobile clients (Expo/React Native fetch) don't send an Origin
  // header at all, so there's no browser CORS enforcement to satisfy -
  // let the request through without an ACAO header.
  if (!origin) {
    return baseHeaders
  }

  // Browser request from a disallowed origin: omit Access-Control-Allow-Origin
  // entirely (fail closed) rather than echoing back an unrelated allowed
  // origin, which the browser would reject anyway but is misleading to log/debug.
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return baseHeaders
  }

  return {
    ...baseHeaders,
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
  }
}

export async function middleware(req: NextRequest) {
  /*
   * Each surface on its own host, when both are configured.
   *
   * A 404 rather than a redirect: `dashboard.blendn.app/api/mobile/...` is not
   * a page that moved, it is a client pointed at the wrong name, and silently
   * redirecting would hide that until something subtler broke.
   */
  if (wrongHost(req.nextUrl.pathname, req.headers.get("host"))) {
    return new NextResponse("Not found", { status: 404 })
  }

  const { pathname } = req.nextUrl
  const origin = req.headers.get("origin")

  // API versioning: rewrite /api/mobile/v1/* to /api/mobile/*
  if (pathname.startsWith("/api/mobile/v1/") || pathname === "/api/mobile/v1") {
    const rewritten = pathname.replace("/api/mobile/v1", "/api/mobile")
    const url = req.nextUrl.clone()
    url.pathname = rewritten
    const response = NextResponse.rewrite(url)
    response.headers.set("X-API-Version", "v1")
    const corsHeaders = getCorsHeaders(origin)
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value)
    })
    return response
  }

  // Rate limit the dashboard credentials sign-in (NextAuth has no built-in
  // rate limiting; this mirrors the limits already applied to mobile auth)
  if (pathname === "/api/auth/callback/credentials" && req.method === "POST") {
    const rateLimited = rateLimit(req, createAuthRateLimit("dashboard-signin"))
    if (rateLimited) {
      return rateLimited
    }
  }

  // Handle CORS for mobile API routes
  if (pathname.startsWith("/api/mobile")) {
    const corsHeaders = getCorsHeaders(origin)

    // Handle preflight OPTIONS request
    if (req.method === "OPTIONS") {
      return new NextResponse(null, {
        status: 200,
        headers: corsHeaders,
      })
    }

    // Add CORS headers to actual requests
    const response = NextResponse.next()
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value)
    })
    return response
  }

  // Handle dashboard auth
  const token = await getToken({ req })

  // Redirect authenticated users away from landing and login pages
  if (pathname === "/" || pathname === "/login") {
    if (token && canAccessDashboard(token.role as user_role)) {
      return NextResponse.redirect(new URL("/dashboard", req.url))
    }
  }

  if (pathname.startsWith("/dashboard")) {
    if (!token) {
      const redirectUrl = req.nextUrl.clone()
      redirectUrl.pathname = "/login"
      return NextResponse.redirect(redirectUrl)
    }
    if (!canAccessDashboard(token.role as user_role)) {
      const redirectUrl = req.nextUrl.clone()
      redirectUrl.pathname = "/login"
      return NextResponse.redirect(redirectUrl)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    "/",
    "/dashboard/:path*",
    "/api/mobile/:path*",
    "/login",
    "/api/auth/callback/credentials",
  ],
  // Note: /api/mobile/v1/* is matched by /api/mobile/:path*
}
