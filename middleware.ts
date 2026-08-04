import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { getToken } from "next-auth/jwt"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"
import { canAccessDashboard } from "@/lib/rbac"
import type { user_role } from "@prisma/client"

const ALLOWED_ORIGINS = [
  "https://api.blendn.app",
  "https://blendn.app",
  process.env.NEXTAUTH_URL,
].filter(Boolean) as string[]

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
