import type { Metadata } from "next"

import { AuthFrame } from "@/components/public-frame"
import { Button } from "@/components/ui/button"
import { unsubscribeTarget } from "@/lib/unsubscribe"

export const dynamic = "force-dynamic"
export const metadata: Metadata = { title: "Unsubscribe · Blend’n", robots: { index: false } }

/**
 * Where a mail's unsubscribe link lands (SCRUM-1282): one sentence and one button. Opening it changes nothing — link
 * scanners open every link — and the button POSTs to /api/email/unsubscribe, which sends the person back here, done.
 * The token is checked before the button is shown, so a broken link says so instead of offering a button that 400s.
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ t?: string; done?: string }> }) {
  const { t, done } = await searchParams
  if (done) {
    return (
      <AuthFrame title="You’re unsubscribed" sub="No more results mails the morning after your nights.">
        <p className="text-[0.8125rem] leading-6 text-muted-foreground">Invites and account mail still come.</p>
      </AuthFrame>
    )
  }

  const valid = (await unsubscribeTarget(t)) !== null
  if (!valid) {
    return (
      <AuthFrame title="This link doesn’t work" sub="Use the unsubscribe link in your newest Blend’n mail, exactly as sent.">
        <p className="text-[0.8125rem] leading-6 text-muted-foreground">Nothing has changed.</p>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame title="Stop the results mails?" sub="You won’t get your night’s numbers the morning after. Invites and account mail still come.">
      <form method="post" action={`/api/email/unsubscribe?t=${encodeURIComponent(t!)}&from=page`}>
        <Button type="submit" size="lg" className="w-full">
          Unsubscribe
        </Button>
      </form>
    </AuthFrame>
  )
}
