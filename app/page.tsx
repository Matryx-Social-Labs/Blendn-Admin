import Link from "next/link"
import {
  IconInnerShadowTop,
  IconListDetails,
  IconUsers,
  IconChartBar,
} from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

const features = [
  {
    icon: IconListDetails,
    title: "Event Management",
    description:
      "Create, edit, and oversee events. Manage group chats, check-ins, and push notifications all from one place.",
  },
  {
    icon: IconUsers,
    title: "User Moderation",
    description:
      "View user accounts, manage roles, and enforce community guidelines to keep the platform safe.",
  },
  {
    icon: IconChartBar,
    title: "Analytics",
    description:
      "Track engagement metrics, event attendance, and platform growth with interactive dashboards.",
  },
]

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 md:px-10">
        <div className="flex items-center gap-2">
          <IconInnerShadowTop className="size-6" />
          <span className="text-lg font-semibold">Blendn Admin</span>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/login">Sign in</Link>
        </Button>
      </header>

      <Separator />

      {/* Hero */}
      <section className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-20 text-center">
        <Badge variant="secondary">Admin Portal</Badge>
        <h1 className="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
          Blendn Admin Dashboard
        </h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          Manage events, moderate users, and monitor analytics for the Blendn
          social platform — all in one place.
        </p>
        <div className="flex gap-3">
          <Button asChild size="lg">
            <Link href="/login">Get Started</Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/dashboard">Go to Dashboard</Link>
          </Button>
        </div>
      </section>

      {/* Feature Cards */}
      <section className="mx-auto w-full max-w-5xl px-6 pb-20">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {features.map((feature) => (
            <Card key={feature.title}>
              <CardHeader>
                <feature.icon className="mb-2 size-8 text-muted-foreground" />
                <CardTitle>{feature.title}</CardTitle>
                <CardDescription>{feature.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      <Separator />

      {/* Footer */}
      <footer className="py-6 text-center text-sm text-muted-foreground">
        Blendn &mdash; Matryx Social Labs
      </footer>
    </div>
  )
}
