/**
 * HTML bodies for the transactional emails.
 *
 * Table layout and inline CSS throughout, because Outlook's rendering engine is
 * Word and supports neither flexbox nor grid. The one `<style>` block holds the
 * dark-mode media query, which Outlook ignores harmlessly.
 *
 * Two shells. The email confirmation and the password reset follow the Claude
 * Design templates (`designEmail`, below); the host emails still use `shell`.
 *
 * Constraints that shaped this more than taste did:
 *
 *   - **Images are blocked by default in many clients**, so every email has to
 *     make sense with them off. In `shell` the wordmark is live text beside a
 *     decorative monogram; in `designEmail` the lockup image carries
 *     alt="Blend'n", which is what a client shows in its place.
 *   - **The design's lockups live on the marketing site**, at
 *     https://www.blendn.app/brand/lockup-{dark,white}.png (the landing repo's
 *     `public/brand/`, rendered from the Illustrator master's vectors). They
 *     exist only once that site is deployed with them.
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

/* -------------------------------------------------------------------------- */
/* The design shell: confirm-email.html and reset-password.html                */
/* -------------------------------------------------------------------------- */

const DESIGN_FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif"
const DESIGN_MUTED = "#6B6461"
/** The marketing site's copies of the lockups, 253x72, shown at 126x36 (their own ratio). */
const BRAND_ASSETS = "https://www.blendn.app/brand"

/* From the design, verbatim: dark mode for clients that honour the media query,
   and the same again under [data-ogsc] for Outlook.com, which rewrites it. */
const DESIGN_CSS = `
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0;padding:0;-webkit-text-size-adjust:100%}
table{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0}
img{border:0;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
.dk{display:none}
@media (prefers-color-scheme:dark){
 .bg{background-color:#0F0E0E!important}
 .card{background-color:#272525!important}
 .t{color:#FFFFFF!important}
 .m{color:#B8B0AC!important}
 .lnk{color:#B8B0AC!important}
 .btn{background-color:#FF906D!important}
 .btn a{color:#5B1600!important}
 .rule{border-top-color:#3A3736!important}
 .lt{display:none!important}
 .dk{display:block!important}
}
[data-ogsc] .bg{background-color:#0F0E0E!important}
[data-ogsc] .card{background-color:#272525!important}
[data-ogsc] .t{color:#FFFFFF!important}
[data-ogsc] .m,[data-ogsc] .lnk{color:#B8B0AC!important}
[data-ogsc] .btn{background-color:#FF906D!important}
[data-ogsc] .btn a{color:#5B1600!important}
[data-ogsc] .lt{display:none!important}
[data-ogsc] .dk{display:block!important}
@media only screen and (max-width:620px){
 .wrap{width:100%!important}
 .pad{padding:32px 24px!important}
 .h1{font-size:26px!important;line-height:32px!important}
}`.trim()

function designPara(html: string): string {
  return `<p style="margin:0 0 16px;font-family:${DESIGN_FONT};font-size:16px;line-height:24px;color:${INK}" class="t">${html}</p>`
}

function designFooterLine(html: string, last = false): string {
  return `<p style="margin:${last ? "0" : "0 0 8px"};font-family:${DESIGN_FONT};font-size:12px;line-height:18px;color:${DESIGN_MUTED}" class="m">${html}</p>`
}

/**
 * The design's shell. Everything interpolated is escaped here, except
 * `paragraphs` and `note`, which are HTML the caller built with esc().
 *
 * Two departures from the design, both kept from `shell`: the raw URL under the
 * button (some clients strip the anchor), and `max-width:100%` on the body
 * table, so it fits a phone whose client ignores the media query.
 */
function designEmail(opts: {
  title: string
  preheader: string
  eyebrow: string
  heading: string
  paragraphs: string[]
  button: { href: string; label: string }
  note: string
  /** What the email is about, for the footer: "account" or "host application". */
  about: string
}): string {
  const address = process.env.EMAIL_FOOTER_ADDRESS?.trim()
  const href = esc(opts.button.href)
  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(opts.title)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
${DESIGN_CSS}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background-color:#FBF8F6" bgcolor="#FBF8F6">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${esc(opts.preheader)}${"&nbsp;&zwnj;".repeat(12)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background-color:#FBF8F6" bgcolor="#FBF8F6">
<tr><td align="center" style="padding:32px 16px">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="wrap" style="width:600px;max-width:100%">
<tr><td style="padding:0 0 24px 0">
<a href="https://www.blendn.app" style="text-decoration:none"><img class="lt" src="${BRAND_ASSETS}/lockup-dark.png" width="126" height="36" alt="Blend'n" style="display:block;width:126px;height:36px"></a>
<!--[if !mso]><!-- --><a href="https://www.blendn.app" class="dk" style="text-decoration:none;display:none;mso-hide:all"><img class="dk" src="${BRAND_ASSETS}/lockup-white.png" width="126" height="36" alt="Blend'n" style="display:none;width:126px;height:36px;mso-hide:all"></a><!--<![endif]-->
</td></tr>
<tr><td class="card" style="background-color:#FFFFFF;border-radius:14px" bgcolor="#FFFFFF">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td class="pad" style="padding:40px">
<p style="margin:0 0 12px;font-family:${DESIGN_FONT};font-size:12px;line-height:16px;letter-spacing:0.06em;text-transform:uppercase;color:${DESIGN_MUTED}" class="m">${esc(opts.eyebrow)}</p>
<h1 class="t h1" style="margin:0 0 20px;font-family:${DESIGN_FONT};font-size:28px;line-height:34px;font-weight:700;letter-spacing:-0.01em;color:${INK};mso-line-height-rule:exactly">${esc(opts.heading)}</h1>
${opts.paragraphs.map(designPara).join("")}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px">
<tr><td class="btn" bgcolor="#F97316" style="background-color:#F97316;border-radius:999px;mso-padding-alt:0">
<a href="${href}" style="display:block;padding:14px 28px;font-family:${DESIGN_FONT};font-size:16px;line-height:20px;font-weight:700;color:${INK};text-decoration:none;border-radius:999px;mso-line-height-rule:exactly">${esc(opts.button.label)}</a>
</td></tr>
</table>
<p style="margin:0 0 24px;font-family:${DESIGN_FONT};font-size:13px;line-height:20px;color:${DESIGN_MUTED};word-break:break-all" class="m">Button not working? Paste this into your browser:<br><a href="${href}" class="lnk" style="color:${DESIGN_MUTED};text-decoration:underline">${href}</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="rule" style="border-top:1px solid #ECE6E2;padding:16px 0 0">
<p style="margin:0;font-family:${DESIGN_FONT};font-size:13px;line-height:20px;color:${DESIGN_MUTED}" class="m">${opts.note}</p>
</td></tr></table>
</td></tr>
</table>
</td></tr>
<tr><td style="padding:24px 8px 0">
${[
  ...(address ? [esc(address)] : []),
  `This is a one-off email about your Blend'n ${esc(opts.about)}, so there is nothing to unsubscribe from.`,
  `Blend'n is built by Matrix Social Labs, Bengaluru, India. Questions about your data: <a href="mailto:privacy@blendn.app" class="lnk" style="color:${DESIGN_MUTED};text-decoration:underline">privacy@blendn.app</a>`,
]
  .map((line, i, all) => designFooterLine(line, i === all.length - 1))
  .join("\n")}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`
}

function heading(text: string): string {
  return `<h1 class="dm-text" style="margin:0 0 14px;font-family:${FONT};font-size:21px;line-height:28px;font-weight:bold;color:${INK};">${esc(text)}</h1>`
}

/* -------------------------------------------------------------------------- */
/* The five                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The design's confirm-email.html. Its copy was written for an attendee's
 * account ("the last step before your first check-in"); this email goes to a
 * host applicant, for whom no account exists yet, so the words say what the
 * link actually does. The 24 hours is the token's lifetime in
 * app/api/onboarding/apply.
 */
export function onboardingVerifyHtml(name: string, orgName: string, link: string): string {
  return designEmail({
    title: "Confirm your email — Blend'n",
    preheader: "One tap confirms your address and sends your host application for review.",
    eyebrow: "Host application",
    heading: "Confirm your email",
    paragraphs: [
      `Hi ${esc(name)}, you applied to host on Blend'n as <b>${esc(orgName)}</b>. Tap the button to confirm this is your address, and your application goes to our team for review. Most are answered within two working days.`,
      "The link works for 24 hours. After that, apply again to get a fresh one.",
    ],
    button: { href: link, label: "Confirm email" },
    note: "Didn't apply to host on Blend'n? You can ignore this email. Nothing happens until the link is used, and no account has been created.",
    about: "host application",
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
  setPasswordLink: string | null
): string {
  const signIn = `${appUrl()}/login`
  // The sign-in address is monospaced: it is the one thing in this email the
  // reader has to type exactly. No password travels here (SCRUM-134).
  const account = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="dm-codebox dm-border" style="margin:22px 0 6px;background-color:#F7F4F3;border:1px solid #E2DAD7;border-radius:10px;"><tr><td style="padding:16px 18px;font-family:'SF Mono',Consolas,Menlo,monospace;font-size:13px;line-height:22px;color:${INK};" class="dm-text"><span style="color:${MUTED};">Email</span><br>${esc(email)}</td></tr></table>`

  return shell({
    title: "Your Blend'n host account is ready",
    preheader: `${orgName} is approved. ${setPasswordLink ? "Set your password to get in." : "Sign in with your existing password."}`,
    body: [
      heading("You're approved"),
      para(
        `Hi ${esc(name)}, <b>${esc(orgName)}</b> has been approved. ${
          setPasswordLink
            ? "Set a password and you&#39;re in."
            : "Sign in to the Blend&#39;n dashboard with your existing password."
        }`
      ),
      account,
      ...(setPasswordLink
        ? [
            button(setPasswordLink, "Set your password"),
            fallbackLink(setPasswordLink),
            note(
              "&#128274; The link works once and expires in 24 hours. If it has, use &ldquo;Forgot password&rdquo; on the sign-in page and a fresh one will be sent."
            ),
          ]
        : [button(signIn, "Sign in to the dashboard"), fallbackLink(signIn)]),
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

/**
 * A claim decision. `what` is the thing claimed, already phrased — "the venue
 * Church Street Social". The reason is the whole point of a decline: without it
 * the claimant re-files identically (SCRUM-117).
 */
export function claimDecisionHtml(
  name: string,
  what: string,
  outcome: "approved" | "declined",
  reason: string | null,
  link: string | null
): string {
  const approved = outcome === "approved"
  return shell({
    title: approved ? `Your claim on ${what} was approved` : `About your claim on ${what}`,
    preheader: approved ? "It's yours — open the dashboard." : "We couldn't approve it — here's why.",
    body: [
      heading(approved ? "Claim approved" : "About your claim"),
      para(
        approved
          ? `Hi ${esc(name)}, your claim on <b>${esc(what)}</b> has been approved. It now belongs to your organisation.`
          : `Hi ${esc(name)}, we&#39;re not able to approve your claim on <b>${esc(what)}</b>.`
      ),
      ...(reason
        ? [
            `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="dm-codebox dm-border" style="margin:18px 0;background-color:#F7F4F3;border:1px solid #E2DAD7;border-radius:10px;"><tr><td style="padding:14px 18px;font-family:${FONT};font-size:14px;line-height:22px;color:${BODY_TEXT};" class="dm-sub">${esc(reason)}</td></tr></table>`,
          ]
        : []),
      ...(link ? [button(link, "Open the dashboard"), fallbackLink(link)] : []),
      note(
        approved
          ? "You can invite colleagues from Your organisation &rarr; Members."
          : "Think this is a mistake? Reply to this email with more detail &mdash; a person reads every reply."
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

/**
 * The design's reset-password.html. The design says 30 minutes; the link lives
 * for one hour (RESET_TTL_MS in app/api/auth/forgot-password), and the mail
 * says what the code does.
 */
export function passwordResetHtml(name: string, link: string): string {
  return designEmail({
    title: "Reset your Blend'n password",
    preheader: "Choose a new password. The link works for one hour.",
    eyebrow: "Your account",
    heading: "Reset your password",
    paragraphs: [
      `Hi ${esc(name)}, someone asked to reset the password for this account. If that was you, choose a new one below.`,
      "The link works for one hour and only once.",
    ],
    button: { href: link, label: "Reset password" },
    note: "Didn't ask for this? Ignore this email and your password stays the same. If it keeps happening, write to privacy@blendn.app.",
    about: "account",
  })
}
