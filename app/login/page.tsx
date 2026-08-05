"use client"

import { logger } from "@/lib/logger"
import Link from "next/link"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { signIn, useSession } from "next-auth/react"
import {
  IconArrowRight,
  IconChartHistogram,
  IconDownload,
  IconSparkles,
} from "@tabler/icons-react"
import { toast } from "sonner"

import { BrandLogo } from "@/components/brand-logo"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

const valueProps = [
  {
    icon: IconChartHistogram,
    title: "Performance reporting",
    description: "User activity, event supply, attendance, and engagement in one operating layer.",
  },
  {
    icon: IconSparkles,
    title: "Role-aware insights",
    description: "Admin, organiser, and venue views share the same brand system with different KPIs.",
  },
  {
    icon: IconDownload,
    title: "Exportable reporting",
    description: "Download platform, organiser, and venue reports directly from the dashboard.",
  },
]

export default function LoginPage() {
  const router = useRouter()
  const { status } = useSession()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (status === "authenticated") {
      router.push("/dashboard")
    }
  }, [status, router])

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)

    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      })

      if (result?.error) {
        throw new Error(result.error)
      }

      toast.success("Signed in")
      router.push("/dashboard")
      router.refresh()
    } catch (error) {
      logger.error("Error logging in", { error: error instanceof Error ? error.message : String(error) })
      toast.error("Invalid email or password")
    } finally {
      setLoading(false)
    }
  }

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="rounded-full border border-border bg-muted px-5 py-3 text-sm text-muted-foreground">
          Loading workspace...
        </div>
      </div>
    )
  }

  return (
    <main className="relative min-h-screen overflow-hidden px-6 py-6 md:px-10">
      <div className="relative mx-auto grid min-h-[calc(100vh-3rem)] max-w-7xl overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-[1.05fr_0.95fr]">
        <section className="flex flex-col justify-between border-b border-border px-6 py-8 lg:border-b-0 lg:border-r lg:px-10 lg:py-10">
          <div className="space-y-8">
            <div className="flex items-start justify-between gap-4">
              <BrandLogo size="hero" />
              <Badge variant="secondary" className="rounded-full px-3 py-1 font-medium">
                Workspace access
              </Badge>
            </div>

            <div className="space-y-4">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                Blend&apos;n workspace
              </p>
              <h1 className="max-w-xl text-4xl font-semibold leading-tight text-foreground sm:text-5xl">
                Manage events, venues, and reporting from one place.
              </h1>
              <p className="max-w-xl text-base leading-7 text-muted-foreground">
                Sign in to manage events, review performance, and monitor venue and audience
                activity across Blend&apos;n.
              </p>
            </div>
          </div>

          <div className="mt-10 grid gap-4">
            {valueProps.map((item) => (
              <div key={item.title} className="rounded-xl border border-border bg-muted/40 p-5">
                <div className="flex items-start gap-4">
                  <div className="rounded-full bg-muted p-2">
                    <item.icon className="size-5 text-primary" />
                  </div>
                  <div className="space-y-1">
                    <h2 className="text-base font-semibold text-foreground">{item.title}</h2>
                    <p className="text-sm leading-6 text-muted-foreground">{item.description}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="flex items-center justify-center px-6 py-8 lg:px-10 lg:py-10">
          <Card className="w-full max-w-md rounded-xl shadow-none">
            <CardContent className="space-y-6 px-6 py-7">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                  Welcome back
                </p>
                <h2 className="text-3xl font-semibold text-foreground">Sign in</h2>
                <p className="text-sm leading-6 text-muted-foreground">
                  Use your app admin, organiser, or venue owner credentials.
                </p>
              </div>

              <form onSubmit={handleLogin} className="space-y-4">
                <Input
                  type="email"
                  placeholder="Email address"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="h-12 rounded-xl"
                  required
                />
                <Input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-12 rounded-xl"
                  required
                />
                <Button type="submit" disabled={loading} className="h-12 w-full rounded-xl">
                  {loading ? "Signing in..." : "Continue to dashboard"}
                  {!loading ? <IconArrowRight className="size-4" /> : null}
                </Button>
              </form>

              <p className="text-sm text-muted-foreground">
                Need the public overview instead?{" "}
                <Link href="/" className="text-foreground underline underline-offset-4">
                  Return to landing
                </Link>
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  )
}
