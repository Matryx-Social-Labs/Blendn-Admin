"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { saveMyBrand, type MyBrand } from "@/lib/sponsor-actions"

/**
 * Create or edit the organisation's brand.
 *
 * Logo and website are optional and say why they are worth filling in, rather
 * than being marked "optional" and left at that. A sponsored message with no
 * logo still runs — it just renders as text in a room where every other
 * participant is a nickname, which is a weaker thing to have paid for.
 */
export function BrandForm({ brand }: { brand: MyBrand | null }) {
  const [name, setName] = useState(brand?.name ?? "")
  const [website, setWebsite] = useState(brand?.website ?? "")
  const [logoUrl, setLogoUrl] = useState(brand?.logo_url ?? "")
  const [pending, start] = useTransition()

  const dirty =
    name !== (brand?.name ?? "") ||
    website !== (brand?.website ?? "") ||
    logoUrl !== (brand?.logo_url ?? "")

  function save() {
    start(async () => {
      try {
        await saveMyBrand({ name, website, logo_url: logoUrl })
        toast.success(brand ? "Brand updated" : "Brand created")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save your brand")
      }
    })
  }

  return (
    <div className="flex max-w-xl flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        {/* h2 — components/site-header.tsx owns the page's only h1. */}
        <h2 className="text-[length:var(--text-h2)] font-bold">
          {brand ? "Your brand" : "Set up your brand"}
        </h2>
        {brand?.claimed_at ? (
          <Badge variant="outline" className="rounded-full">
            Claimed
          </Badge>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="brand-name">Name</Label>
        <Input
          id="brand-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Red Bull"
        />
        <p className="text-[0.8125rem] text-muted-foreground">
          Exactly as it should read in the room.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="brand-website">Website</Label>
        <Input
          id="brand-website"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="https://redbull.com"
        />
        <p className="text-[0.8125rem] text-muted-foreground">
          How an organiser tells you apart from another brand with a similar
          name, when they pick you from a list.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="brand-logo">Logo URL</Label>
        <Input
          id="brand-logo"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          placeholder="https://…/logo.png"
        />
        <p className="text-[0.8125rem] text-muted-foreground">
          Shown small, beside your name. Without one your messages run as plain
          text.
        </p>
      </div>

      {brand ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          {brand.placementCount === 0
            ? "No placements yet."
            : `${brand.placementCount} placement${brand.placementCount === 1 ? "" : "s"} use this brand. Renaming it changes how they all read.`}
        </p>
      ) : null}

      <Button
        className="self-start"
        disabled={pending || !dirty || name.trim().length < 2}
        onClick={save}
      >
        {brand ? "Save changes" : "Create brand"}
      </Button>
    </div>
  )
}
