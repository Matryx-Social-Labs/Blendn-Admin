/**
 * Load one external script, and be able to load it again after it failed.
 *
 * `next/script` cannot be the loader for Razorpay Checkout: it remembers every
 * `src` it has ever tried, including one that failed, so a second `<Script>` for
 * the same URL returns at once and never fires `onReady` or `onError`. The Plan
 * page's "Try again" then flipped back to "Checkout is loading…" and stayed
 * there until the page was reloaded (step 16f, seen on staging).
 *
 * Every call makes a fresh element, and a failed one is removed so it cannot
 * linger in `<head>`. The returned function detaches the handlers and drops a
 * script that is still pending, for a component that unmounted first.
 */
export function loadScript(
  src: string,
  doc: Pick<Document, "createElement" | "head">,
  onResult: (loaded: boolean) => void
): () => void {
  const el = doc.createElement("script")
  el.src = src
  el.async = true
  el.onload = () => onResult(true)
  el.onerror = () => {
    el.remove()
    onResult(false)
  }
  doc.head.appendChild(el)
  return () => {
    el.onload = null
    el.onerror = null
    el.remove()
  }
}
