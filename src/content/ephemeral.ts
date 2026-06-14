/**
 * Architecture A — ephemeral, on-demand ARIA injection.
 *
 * We NEVER write a label into the page at load. Instead we remember, per
 * focusable control, the accessible name its unlabeled icon should announce,
 * and we write a single `aria-label` onto that control ONLY while it actually
 * holds DOM focus (focusin → set, focusout → remove).
 *
 * Why: invisible bot challenges (Cloudflare managed challenge, DataDome,
 * Vercel BotID, Kasada) hash/monitor the page DOM during the first seconds of
 * load and score any divergence from the server baseline as tampering. With
 * this strategy the DOM is byte-identical to what the server sent throughout
 * the challenge window; the only mutation that ever happens is a single
 * attribute on the element the human just focused — correlated with a genuine
 * keyboard/pointer event and gone again on blur. That is indistinguishable
 * from the site's own focus-driven ARIA, and is the *opposite* of a bot signal.
 *
 * Caveat (validate with a real screen reader): some SR/browser pairs cache the
 * accessible name at the instant focus is processed. We inject in the *capture*
 * phase of `focusin` (the earliest focus hook, before paint and before the SR's
 * focus announcement in practice) to win that race. If a given SR still misses
 * it, the fallback is to pre-arm on Tab keydown — structured so that's an easy
 * follow-up.
 *
 * Coverage: only icons reachable by keyboard focus (icon-only buttons/links,
 * focusable svgs) are handled here. Non-focusable standalone icons are out of
 * reach by design — those belong to the extension-owned reader surface
 * (Architecture B), a separate follow-up.
 */
import { hasOwnAccessibleName } from '@/content/freeLabel';

interface Registered {
  /** Composed accessible name to inject on focus (incl. attribution suffix). */
  name: string;
  /** True only when the focus target is the icon itself (a focusable <svg>) and
   *  needs role="img" to be announced as an image. Never set for real controls
   *  (a <button>/<a> already has the right role; we must not clobber it). */
  needsRoleImg: boolean;
}

export class EphemeralInjector {
  private targets = new WeakMap<Element, Registered>();
  /** The element we currently have a label injected on (for blur/disarm cleanup). */
  private active: { el: Element; addedRole: boolean } | null = null;
  private armed = false;
  private listening = false;

  /** Remember the name a focusable control should announce when focused. */
  register(control: Element, name: string, needsRoleImg: boolean): void {
    this.targets.set(control, { name, needsRoleImg });
  }

  /** Start reacting to focus. Idempotent; listeners attach once per page. */
  arm(): void {
    this.armed = true;
    if (this.listening) return;
    this.listening = true;
    document.addEventListener('focusin', this.onFocusIn, true);
    document.addEventListener('focusout', this.onFocusOut, true);
  }

  /** Stop reacting and strip any currently-injected label. Listeners stay
   *  attached (passive, they early-return) so re-arm is instant. */
  disarm(): void {
    this.armed = false;
    if (this.active) this.removeActive();
  }

  private onFocusIn = (e: FocusEvent): void => {
    if (!this.armed) return;
    const el = e.target as Element | null;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    const reg = this.targets.get(el);
    if (!reg) return;
    // Re-check do-no-harm at focus time: the page may have named it since we
    // classified (SPAs, late hydration). Never clobber a real name.
    if (el.hasAttribute('aria-label') || hasOwnAccessibleName(el)) return;

    el.setAttribute('aria-label', reg.name);
    let addedRole = false;
    if (reg.needsRoleImg && !el.hasAttribute('role')) {
      el.setAttribute('role', 'img');
      addedRole = true;
    }
    this.active = { el, addedRole };
  };

  private onFocusOut = (e: FocusEvent): void => {
    const el = e.target as Element | null;
    if (!el || !this.active || this.active.el !== el) return;
    this.removeActive();
  };

  private removeActive(): void {
    if (!this.active) return;
    const { el, addedRole } = this.active;
    el.removeAttribute('aria-label');
    if (addedRole) el.removeAttribute('role');
    this.active = null;
  }
}
