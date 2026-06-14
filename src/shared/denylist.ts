/**
 * Site denylist: hosts where the content script must NOT activate.
 *
 * Why this exists: invisible bot challenges (Vercel BotID/Kasada, Cloudflare
 * Turnstile, DataDome) fingerprint the page and run anti-tamper integrity
 * monitors in the first seconds of load. Our content script shares the page DOM
 * (isolated JS world, SHARED DOM), so the aria-label/title/sentinel attributes
 * we write — plus the document-wide MutationObserver — read as tampering and can
 * fail the challenge. Bailing out entirely on these hosts is the clean fix.
 *
 * Vercel BotID is invisible and served first-party on the customer's own domain,
 * so it has no fixed host to pre-list — the user-editable denylist is the real
 * lever there. The built-in list only covers third-party challenge IFRAMES,
 * which our `allFrames` content script would otherwise mutate.
 */

/** Third-party challenge-widget iframe hosts. Always denylisted. */
export const BUILTIN_CHECKPOINT_HOSTS: readonly string[] = [
  'challenges.cloudflare.com', // Cloudflare Turnstile / "Just a moment…" challenge iframe
  'newassets.hcaptcha.com', // hCaptcha challenge iframe
  'geo.captcha-delivery.com', // DataDome challenge iframe
];

/**
 * Normalize a user-entered denylist entry to a bare hostname. Accepts a full URL,
 * a `*.`/`.`-prefixed pattern, or a host[:port] — returns lowercased host only.
 */
export function normalizeDenylistEntry(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip scheme
  s = s.split('/')[0]; // strip path
  s = s.split(':')[0]; // strip port
  s = s.replace(/^\*\./, '').replace(/^\./, ''); // strip leading wildcard/dot
  return s;
}

/** True if `host` is `entry` or a subdomain of it. */
function hostMatches(host: string, entry: string): boolean {
  if (!entry) return false;
  return host === entry || host.endsWith('.' + entry);
}

/**
 * Should the extension stay off for this hostname? True if it matches a built-in
 * checkpoint host or any user denylist entry (exact host or subdomain).
 */
export function isDenylisted(host: string, userList: readonly string[] = []): boolean {
  const h = host.toLowerCase();
  for (const e of BUILTIN_CHECKPOINT_HOSTS) if (hostMatches(h, e)) return true;
  return isHostInList(h, userList);
}

/** True if `host` matches any entry in `list` (exact host or subdomain). Used for
 *  the safe-mode site list (and reused by the denylist). */
export function isHostInList(host: string, list: readonly string[] = []): boolean {
  const h = host.toLowerCase();
  for (const raw of list) if (hostMatches(h, normalizeDenylistEntry(raw))) return true;
  return false;
}
