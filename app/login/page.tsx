"use client"

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
    title: "Traction metrics",
    description: "User activation, event supply, attendance, and engagement in one operating layer.",
  },
  {
    icon: IconSparkles,
    title: "Role-aware insights",
    description: "Admin, organiser, and venue views share the same brand system with different KPIs.",
  },
  {
    icon: IconDownload,
    title: "Exportable reporting",
    description: "Investor snapshots and operator exports are ready directly from the dashboard.",
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
      console.error("Error logging in:", error)
      toast.error("Invalid email or password")
    } finally {
      setLoading(false)
    }
  }

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="rounded-full border border-white/10 bg-white/6 px-5 py-3 text-sm text-white/70">
          Loading workspace...
        </div>
      </div>
    )
  }

  return (
    <main className="relative min-h-screen overflow-hidden px-6 py-6 md:px-10">
      <div className="brand-mesh pointer-events-none absolute inset-0 opacity-80" />

      <div className="relative mx-auto grid min-h-[calc(100vh-3rem)] max-w-7xl overflow-hidden rounded-[2rem] border border-white/10 brand-surface lg:grid-cols-[1.05fr_0.95fr]">
        <section className="flex flex-col justify-between border-b border-white/10 px-6 py-8 lg:border-b-0 lg:border-r lg:px-10 lg:py-10">
          <div className="space-y-8">
            <div className="flex items-start justify-between gap-4">
              <BrandLogo showTagline />
              <Badge className="brand-chip rounded-full px-3 py-1 font-medium">
                Private admin access
              </Badge>
            </div>

            <div className="space-y-4">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/45">
                Blend&apos;n dashboard
              </p>
              <h1 className="max-w-xl text-4xl font-semibold leading-tight text-white sm:text-5xl">
                Operate the product like a marketplace, not a spreadsheet.
              </h1>
              <p className="max-w-xl text-base leading-7 text-white/68">
                Sign in to review investor-ready health metrics, host performance, venue demand,
                and the event-level signals that matter while Blend&apos;n is still in MVP.
              </p>
            </div>
          </div>

          <div className="mt-10 grid gap-4">
            {valueProps.map((item) => (
              <div
                key={item.title}
                className="rounded-[1.4rem] border border-white/10 bg-white/[0.04] p-5"
              >
                <div className="flex items-start gap-4">
                  <div className="rounded-full bg-white/8 p-2">
                    <item.icon className="size-5 text-[#F05423]" />
                  </div>
                  <div className="space-y-1">
                    <h2 className="text-base font-semibold text-white">{item.title}</h2>
                    <p className="text-sm leading-6 text-white/66">{item.description}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="flex items-center justify-center px-6 py-8 lg:px-10 lg:py-10">
          <Card className="w-full max-w-md rounded-[1.8rem] border-white/10 bg-black/30 text-white shadow-none">
            <CardContent className="space-y-6 px-6 py-7">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/45">
                  Welcome back
                </p>
                <h2 className="text-3xl font-semibold text-white">Sign in</h2>
                <p className="text-sm leading-6 text-white/62">
                  Use your admin, organiser, or venue owner credentials.
                </p>
              </div>

              <form onSubmit={handleLogin} className="space-y-4">
                <Input
                  type="email"
                  placeholder="Email address"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="h-12 rounded-2xl border-white/10 bg-white/6 text-white placeholder:text-white/35"
                  required
                />
                <Input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-12 rounded-2xl border-white/10 bg-white/6 text-white placeholder:text-white/35"
                  required
                />
                <Button
                  type="submit"
                  disabled={loading}
                  className="h-12 w-full rounded-2xl bg-[#F05423] text-white hover:bg-[#d84a1d]"
                >
                  {loading ? "Signing in..." : "Continue to dashboard"}
                  {!loading ? <IconArrowRight className="size-4" /> : null}
                </Button>
              </form>

              <p className="text-sm text-white/50">
                Need the public overview instead?{" "}
                <Link href="/" className="text-white underline decoration-white/25 underline-offset-4">
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
