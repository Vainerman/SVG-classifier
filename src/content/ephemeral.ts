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

/**
 * 'write' = normal ephemeral injection (focusin → aria-label → focusout removes).
 * 'speak' = SAFE MODE: never touch the page; instead, on the safe-mode hotkey
 *           (Alt+Shift+I), speak the focused icon's label via speechSynthesis.
 *           For sites whose continuous integrity monitors catch even the
 *           transient focus write (e.g. chatgpt.com).
 */
export type InjectorMode = 'write' | 'speak';

export class EphemeralInjector {
  private targets = new WeakMap<Element, Registered>();
  /** The element we currently have a label injected on (for blur/disarm cleanup). */
  private active: { el: Element; addedRole: boolean } | null = null;
  private armed = false;
  private listening = false;
  private mode: InjectorMode = 'write';

  /** Remember the name a focusable control should announce when focused/queried. */
  register(control: Element, name: string, needsRoleImg: boolean): void {
    this.targets.set(control, { name, needsRoleImg });
  }

  /** Start reacting. In 'write' mode, focus injects/strips aria; in 'speak' mode,
   *  the hotkey speaks the focused icon's label and nothing touches the page. */
  arm(mode: InjectorMode = 'write'): void {
    this.armed = true;
    this.mode = mode;
    if (this.listening) return;
    this.listening = true;
    if (mode === 'speak') {
      document.addEventListener('keydown', this.onHotkey, true);
    } else {
      document.addEventListener('focusin', this.onFocusIn, true);
      document.addEventListener('focusout', this.onFocusOut, true);
    }
  }

  /** Stop reacting: strip any injected label, cancel speech, remove listeners
   *  (so a re-arm attaches the correct set for the new mode). */
  disarm(): void {
    this.armed = false;
    if (this.active) this.removeActive();
    if (this.listening) {
      document.removeEventListener('focusin', this.onFocusIn, true);
      document.removeEventListener('focusout', this.onFocusOut, true);
      document.removeEventListener('keydown', this.onHotkey, true);
      this.listening = false;
    }
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* speech unavailable */
    }
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

  // ── Safe mode (speak) ──────────────────────────────────────────────────────

  /** Alt+Shift+I (layout-independent via code) → speak the focused icon's label.
   *  Reads document.activeElement (drilling into open shadow roots), looks it up
   *  in the registry, and speaks — never touches the DOM. */
  private onHotkey = (e: KeyboardEvent): void => {
    if (!this.armed || this.mode !== 'speak') return;
    if (!(e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyI')) return;
    const el = deepActiveElement();
    const reg = el ? this.targets.get(el) : undefined;
    if (!reg) return; // focused thing isn't an icon we labeled → stay silent
    e.preventDefault();
    this.speak(reg.name);
  };

  private speak(name: string): void {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel(); // drop any queued utterance so rapid presses don't pile up
      synth.speak(new SpeechSynthesisUtterance(name));
    } catch {
      /* speechSynthesis unavailable in this context */
    }
  }
}

/** The genuinely-focused element, descending through open shadow roots. */
function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}
