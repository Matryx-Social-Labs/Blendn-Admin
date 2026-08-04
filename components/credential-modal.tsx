"use client"

import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { createRoleUser } from "@/lib/admin-role-actions"
import type { user_role } from "@prisma/client"

interface Credentials {
  name: string
  email: string
  password: string
}

interface CredentialModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  role: user_role
  roleLabel: string
}

export function CredentialModal({ open, onOpenChange, role, roleLabel }: CredentialModalProps) {
  const [step, setStep] = React.useState<"form" | "result">("form")
  const [isLoading, setIsLoading] = React.useState(false)
  const [name, setName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [credentials, setCredentials] = React.useState<Credentials | null>(null)

  const handleReset = () => {
    setStep("form")
    setName("")
    setEmail("")
    setCredentials(null)
  }

  const handleClose = (open: boolean) => {
    if (!open) handleReset()
    onOpenChange(open)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !email.trim()) return
    setIsLoading(true)
    try {
      const result = await createRoleUser(name.trim(), email.trim(), role)
      setCredentials(result)
      setStep("result")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create account")
    } finally {
      setIsLoading(false)
    }
  }

  const copyAll = async () => {
    if (!credentials) return
    const text = `Name: ${credentials.name}\nEmail: ${credentials.email}\nPassword: ${credentials.password}`
    try {
      // Unavailable on insecure origins and rejects when permission is denied.
      // These are one-time credentials, so a success toast on a failed copy
      // loses them.
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(text)
      toast.success("Credentials copied to clipboard")
    } catch {
      toast.error("Couldn't copy automatically — select the details and copy them manually")
    }
  }

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent className="sm:max-w-md">
        {step === "form" ? (
          <>
            <SheetHeader>
              <SheetTitle>Generate {roleLabel} Credentials</SheetTitle>
              <SheetDescription>
                Enter the new {roleLabel.toLowerCase()}&apos;s details. A secure password will be
                generated and shown once — share it directly with them.
              </SheetDescription>
            </SheetHeader>
            <form onSubmit={handleSubmit} className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="cred-name">Name</Label>
                <Input
                  id="cred-name"
                  placeholder="Jane Smith"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cred-email">Email</Label>
                <Input
                  id="cred-email"
                  type="email"
                  placeholder="jane@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <SheetFooter>
                <Button type="button" variant="outline" onClick={() => handleClose(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isLoading}>
                  {isLoading ? "Creating..." : "Generate Credentials"}
                </Button>
              </SheetFooter>
            </form>
          </>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle>Credentials Generated</SheetTitle>
              <SheetDescription>
                Copy and share these credentials with the new {roleLabel.toLowerCase()}. The
                password will <strong>not</strong> be shown again.
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 py-4">
              {[
                { label: "Name", value: credentials?.name },
                { label: "Email", value: credentials?.email },
                { label: "Password", value: credentials?.password },
              ].map(({ label, value }) => (
                <div key={label} className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{label}</Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-md border bg-muted px-3 py-2 text-sm font-mono break-all">
                      {value}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(value ?? "")
                        toast.success(`${label} copied`)
                      }}
                    >
                      Copy
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <SheetFooter className="gap-2">
              <Button variant="outline" onClick={copyAll}>
                Copy All
              </Button>
              <Button onClick={() => handleClose(false)}>Done</Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
