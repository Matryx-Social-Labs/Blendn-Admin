import type { AppLinks } from "@/lib/app-links"
import { Button } from "@/components/ui/button"

/**
 * "Open Blend'n" for an attendee who has just reset their password: the app's
 * own scheme, and the store listings as the fallback for a phone without it
 * (and for a computer, where the scheme opens nothing). A plain anchor, not a
 * router link: `blendn://` is not a page of this site.
 */
export function OpenTheApp({ app }: { app: AppLinks | null }) {
  return (
    <>
      <Button asChild>
        <a href={app?.deepLink ?? "blendn://"}>Open Blend&apos;n</a>
      </Button>
      {app?.appStoreUrl || app?.playStoreUrl ? (
        <p className="text-center text-[0.8125rem] text-muted-foreground">
          Don&apos;t have it yet?{" "}
          {app.appStoreUrl ? (
            <a href={app.appStoreUrl} className="text-foreground underline underline-offset-4">
              App Store
            </a>
          ) : null}
          {app.appStoreUrl && app.playStoreUrl ? " · " : null}
          {app.playStoreUrl ? (
            <a href={app.playStoreUrl} className="text-foreground underline underline-offset-4">
              Google Play
            </a>
          ) : null}
        </p>
      ) : null}
    </>
  )
}
