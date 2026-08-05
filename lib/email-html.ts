/**
 * HTML bodies for the five transactional emails.
 *
 * Table layout and inline CSS throughout, because Outlook's rendering engine is
 * Word and supports neither flexbox nor grid. The only `<style>` block is the
 * dark-mode media query, which Outlook ignores harmlessly.
 *
 * Three constraints that shaped this more than taste did:
 *
 *   - **Images are blocked by default in many clients**, so every email has to
 *     make sense with them off. The wordmark is live text; the monogram beside
 *     it is decoration that can vanish without loss.
 *   - **Only the gradient monogram is hosted.** `public/brand/` has
 *     `lockup-white.png`, which is invisible on the light background these
 *     emails use, so the design's light/dark logo swap is not available. The
 *     gradient mark reads on both.
 *   - **The footer address is not invented.** The design mocked up a registered
 *     office; shipping a made-up address in a compliance footer is worse than
 *     shipping none, so it comes from `EMAIL_FOOTER_ADDRESS` and the line is
 *     omitted when that is unset.
 */

/**
 * Read directly rather than importing `appUrl` from ./email.
 *
 * email.ts imports the templates from here, so importing back creates a cycle.
 * It happens to work today because every call is inside a function body, but a
 * cycle that survives only by call ordering is a trap for whoever edits next.
 */
function appUrl(): string {
  return (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(/\/$/, "")
}

/* Light palette inline, dark via the media query — every value is a literal
   because CSS custom properties do not survive most mail clients. */
const INK = "#0D0C0C"
const BODY_TEXT = "#3D3638"
const MUTED = "#8A8184"
const PAGE_BG = "#F3EFED"
const ORANGE = "#F05423"
const FONT = "Arial,Helvetica,sans-serif"

/** Anything interpolated into HTML goes through this. Names carry apostrophes. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const DARK_MODE_CSS = `
@media (prefers-color-scheme: dark){
  body,.dm-body{background-color:#0D0C0C !important;}
  .dm-card{background-color:#1B1718 !important;}
  .dm-text{color:#EDE8E9 !important;}
  .dm-sub{color:#C4BBBE !important;}
  .dm-muted{color:#8A8184 !important;}
  .dm-border{border-color:#3A3335 !important;}
  .dm-codebox{background-color:#241F20 !important;border-color:#4A4143 !important;}
}`.trim()

/**
 * A bulletproof button: a table cell carrying the background, an anchor
 * carrying the padding. A styled `<a>` alone renders as a bare link in Outlook.
 */
function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 10px;"><tr><td bgcolor="${ORANGE}" style="border-radius:8px;"><a href="${esc(href)}" target="_blank" style="display:inline-block;padding:13px 30px;font-family:${FONT};font-size:15px;font-weight:bold;color:${INK};text-decoration:none;border-radius:8px;">${esc(label)}</a></td></tr></table>`
}

/** The raw URL under every button — some clients strip the anchor entirely. */
function fallbackLink(href: string): string {
  return `<p style="margin:0 0 4px;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};word-break:break-all;">Button not working? Paste this into your browser:<br><a href="${esc(href)}" style="color:${ORANGE};text-decoration:underline;">${esc(href)}</a></p>`
}

function note(text: string): string {
  return `<p class="dm-muted" style="margin:14px 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">${text}</p>`
}

function para(text: string): string {
  return `<p class="dm-sub" style="margin:0 0 12px;font-family:${FONT};font-size:14px;line-height:22px;color:${BODY_TEXT};">${text}</p>`
}

/**
 * The shell.
 *
 * `preheader` is the grey line an inbox shows beside the subject. Left unset it
 * leaks the first words of the body, which for these is usually "Hi Asha,".
 */
function shell(opts: { title: string; preheader: string; body: string }): string {
  const address = process.env.EMAIL_FOOTER_ADDRESS?.trim()

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(opts.title)}</title>
<style>${DARK_MODE_CSS}</style></head>
<body class="dm-body" style="margin:0;padding:0;background-color:${PAGE_BG};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">
<tr><td style="padding:0 8px 18px;">
  <!-- Monogram as an image, wordmark as live text: with images blocked the
       brand still reads, which is the state a large share of recipients are in. -->
  <img src="${appUrl()}/brand/monogram-gradient.png" alt="" width="26" height="26" style="display:inline-block;width:26px;height:26px;border:0;vertical-align:middle;">
  <span class="dm-text" style="font-family:${FONT};font-size:17px;font-weight:bold;color:${INK};vertical-align:middle;padding-left:8px;">Blend&#39;n</span>
</td></tr>
<tr><td class="dm-card" bgcolor="#FFFFFF" style="background-color:#FFFFFF;border-radius:14px;padding:34px 36px 30px;">
${opts.body}
</td></tr>
<tr><td style="padding:22px 8px 0;">
${address ? `  <p class="dm-muted" style="margin:0 0 4px;font-family:${FONT};font-size:11.5px;line-height:17px;color:${MUTED};">${esc(address)}</p>\n` : ""}  <p class="dm-muted" style="margin:0;font-family:${FONT};font-size:11.5px;line-height:17px;color:${MUTED};">This is a transactional email about your Blend&#39;n account &mdash; it sends regardless of notification preferences.</p>
</td></tr>
</table></td></tr></table></body></html>`
}

function heading(text: string): string {
  return `<h1 class="dm-text" style="margin:0 0 14px;font-family:${FONT};font-size:21px;line-height:28px;font-weight:bold;color:${INK};">${esc(text)}</h1>`
}

/* -------------------------------------------------------------------------- */
/* The five                                                                    */
/* -------------------------------------------------------------------------- */

export function onboardingVerifyHtml(name: string, orgName: string, link: string): string {
  return shell({
    title: "Confirm your email — Blend'n",
    preheader: "One click confirms your address and moves your host application forward.",
    body: [
      heading("Confirm your email"),
      para(
        `Hi ${esc(name)}, you applied to host on Blend&#39;n as <b>${esc(orgName)}</b>. Confirm this address and your application goes to our team for review &mdash; most are answered within two working days.`
      ),
      button(link, "Confirm email address"),
      fallbackLink(link),
      note("&#9202; This link expires in 24 hours. After that, re-apply to get a fresh one."),
      note(
        "Didn&#39;t apply to Blend&#39;n? Someone typed your address by mistake &mdash; ignore this email and nothing happens. No account has been created."
      ),
    ].join("\n"),
  })
}

export function inviteHtml(
  orgName: string,
  inviterName: string,
  link: string,
  roleLabel: string
): string {
  return shell({
    title: `${inviterName} invited you to ${orgName}`,
    preheader: `Join ${orgName} on Blend'n as ${roleLabel}.`,
    body: [
      heading(`Join ${orgName}`),
      para(
        `<b>${esc(inviterName)}</b> has invited you to join <b>${esc(orgName)}</b> on Blend&#39;n as <b>${esc(roleLabel)}</b>.`
      ),
      button(link, "Accept invitation"),
      fallbackLink(link),
      note(
        "&#9202; This link expires in 7 days and works only for the address it was sent to. You&#39;ll need to sign in to accept."
      ),
      note(
        "Weren&#39;t expecting this? Ignore it &mdash; nothing happens until you accept."
      ),
    ].join("\n"),
  })
}

export function approvedHtml(
  name: string,
  orgName: string,
  email: string,
  password: string
): string {
  const signIn = `${appUrl()}/login`
  // The credential block is visually distinct and monospaced: it is the one
  // thing in this email the reader has to copy exactly.
  const credentials = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="dm-codebox dm-border" style="margin:22px 0 6px;background-color:#F7F4F3;border:1px solid #E2DAD7;border-radius:10px;"><tr><td style="padding:16px 18px;font-family:'SF Mono',Consolas,Menlo,monospace;font-size:13px;line-height:22px;color:${INK};" class="dm-text"><span style="color:${MUTED};">Email</span><br>${esc(email)}<br><br><span style="color:${MUTED};">Password</span><br>${esc(password)}</td></tr></table>`

  return shell({
    title: "Your Blend'n host account is ready",
    preheader: `${orgName} is approved. Your sign-in details are inside.`,
    body: [
      heading("You're approved"),
      para(
        `Hi ${esc(name)}, <b>${esc(orgName)}</b> has been approved. You can sign in to the Blend&#39;n dashboard now.`
      ),
      credentials,
      note(
        "&#128274; Change this password after your first sign-in, from Settings. Anyone with this email can read it."
      ),
      button(signIn, "Sign in to the dashboard"),
      fallbackLink(signIn),
      note(
        "Once you&#39;re in, invite your colleagues from Your organisation &rarr; Members."
      ),
    ].join("\n"),
  })
}

export function declinedHtml(name: string, reason: string): string {
  return shell({
    title: "About your Blend'n host application",
    preheader: "We couldn't approve your application — here's why.",
    body: [
      heading("About your application"),
      para(`Hi ${esc(name)}, we&#39;re not able to approve your host application at the moment.`),
      // The reason is the whole point of the email; without it the applicant
      // reapplies identically and hits the duplicate guard.
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="dm-codebox dm-border" style="margin:18px 0;background-color:#F7F4F3;border:1px solid #E2DAD7;border-radius:10px;"><tr><td style="padding:14px 18px;font-family:${FONT};font-size:14px;line-height:22px;color:${BODY_TEXT};" class="dm-sub">${esc(reason)}</td></tr></table>`,
      note(
        "Think this is a mistake? Reply to this email with more detail about your organisation &mdash; a person reads every reply."
      ),
    ].join("\n"),
  })
}

export function domainVerifyHtml(domain: string, link: string): string {
  return shell({
    title: `Verify ${domain} for Blend'n`,
    preheader: `Confirm that your organisation controls ${domain}.`,
    body: [
      heading(`Verify ${esc(domain)}`),
      para(
        `Someone has asked to verify <b>${esc(domain)}</b> for an organisation on Blend&#39;n. Verifying it lets that organisation restrict its invitations to this domain.`
      ),
      button(link, "Verify this domain"),
      fallbackLink(link),
      note("&#9202; This link expires in 24 hours."),
      note(
        "Wasn&#39;t expecting this? Ignore it &mdash; the domain will not be verified, and whoever asked is told nothing about you."
      ),
    ].join("\n"),
  })
}
