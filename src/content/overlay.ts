/**
 * The primary deliverable: inject the predicted label as ARIA so a standard
 * screen reader announces it, attributed to us as the source. Visual overlays
 * are a demoted, opt-in debug aid.
 *
 * Do-no-harm rules enforced here:
 *  - write once, idempotently (sentinel guards re-application);
 *  - never write below-threshold/unknown labels;
 *  - the debug badge is aria-hidden and never affects layout or the a11y tree.
 */
import {
  SENTINEL_ATTR,
  SENTINEL_SKIP,
  MOCK_MODE,
  type AttributionMode,
  type BehaviorSettings,
} from '@/shared/config';
import type { IconKind } from '@/content/extract';
import type { ClassifyResult } from '@/shared/messages';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface LabelDisplay {
  /** The accessible name written to aria-label / <title> / alt. */
  accessibleName: string;
  /** Optional aria-roledescription (attribution mode). */
  roleDescription?: string;
  /** Short text shown in the debug badge. */
  badgeText: string;
}

/** Compose the announced name from a label + the chosen attribution mode. */
export function composeLabel(
  label: string,
  settings: Pick<BehaviorSettings, 'attribution' | 'attributionText' | 'mockAttributionText'>,
): LabelDisplay {
  const suffix = MOCK_MODE ? settings.mockAttributionText : settings.attributionText;
  const mode: AttributionMode = settings.attribution;

  if (mode === 'roledescription') {
    return {
      accessibleName: label,
      roleDescription: MOCK_MODE ? 'mock label' : 'auto-labeled icon',
      badgeText: label,
    };
  }
  if (mode === 'none') {
    return { accessibleName: label, badgeText: label };
  }
  // 'suffix' (default): "home (auto-labeled)" / "home (mock label)"
  return { accessibleName: `${label} ${suffix}`.trim(), badgeText: label };
}

/** Has this node already been handled by us? */
export function isHandled(el: Element): boolean {
  return el.hasAttribute(SENTINEL_ATTR);
}

/** Mark a node as deliberately skipped (already accessible / decorative). */
export function markSkipped(el: Element): void {
  el.setAttribute(SENTINEL_ATTR, SENTINEL_SKIP);
}

/**
 * Apply a label to the icon node. Returns true if aria was written.
 * `kind` selects the injection strategy. Idempotent.
 */
export function applyLabel(
  el: Element,
  kind: IconKind,
  result: ClassifyResult,
  settings: BehaviorSettings,
): boolean {
  // Already labeled with this exact value → no-op (avoids attribute churn that
  // could re-trigger observers or confuse screen-reader caches).
  if (el.getAttribute(SENTINEL_ATTR) === result.label) return false;

  const display = composeLabel(result.label, settings);

  if (kind === 'img-svg') {
    // Only fill an empty/missing alt (non-empty alt is caught upstream).
    const alt = el.getAttribute('alt');
    if (!alt) el.setAttribute('alt', display.accessibleName);
  } else {
    // inline <svg> or sprite-wrapping <svg>.
    if (!el.getAttribute('role')) el.setAttribute('role', 'img');
    el.setAttribute('aria-label', display.accessibleName);
    if (display.roleDescription) {
      el.setAttribute('aria-roledescription', display.roleDescription);
    }
    injectTitle(el, display.accessibleName);
  }

  el.setAttribute(SENTINEL_ATTR, result.label);

  if (settings.debugBadge) badgeLayer.show(el, display.badgeText, result);
  return true;
}

/** Inject/replace a <title> as the SVG's primary accessible-name source. */
function injectTitle(svg: Element, name: string): void {
  let title = Array.from(svg.children).find(
    (c) => c.tagName.toLowerCase() === 'title',
  );
  if (!title) {
    title = svg.ownerDocument.createElementNS(SVG_NS, 'title');
    svg.insertBefore(title, svg.firstChild);
  }
  title.textContent = name;
}

// ── Debug badge layer ────────────────────────────────────────────────────────
// A single body-appended shadow host holds all badges (aria-hidden, absolutely
// positioned). Never injected inside the icon → zero layout shift, no inherited
// page CSS, no double-speak.
class BadgeLayer {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private badges = new Map<Element, HTMLElement>();
  private rafPending = false;

  private ensureHost(): ShadowRoot {
    if (this.root) return this.root;
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    // Append to documentElement so it survives body replacement on some SPAs.
    (document.documentElement || document.body).appendChild(host);
    this.host = host;
    this.root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .badge{position:fixed;transform:translateY(-100%);
        font:600 10px/1.4 system-ui,sans-serif;color:#fff;background:#5b21b6;
        padding:1px 5px;border-radius:0 4px 4px 0;white-space:nowrap;
        box-shadow:0 1px 3px rgba(0,0,0,.35);pointer-events:none;}
      .outline{position:fixed;border:1.5px dashed #7c3aed;border-radius:3px;
        pointer-events:none;box-sizing:border-box;}`;
    this.root.appendChild(style);
    window.addEventListener('scroll', this.scheduleReposition, true);
    window.addEventListener('resize', this.scheduleReposition, true);
    return this.root;
  }

  show(el: Element, text: string, result: ClassifyResult): void {
    const root = this.ensureHost();
    let wrap = this.badges.get(el);
    if (!wrap) {
      wrap = document.createElement('div');
      const outline = document.createElement('div');
      outline.className = 'outline';
      const badge = document.createElement('div');
      badge.className = 'badge';
      wrap.appendChild(outline);
      wrap.appendChild(badge);
      root.appendChild(wrap);
      this.badges.set(el, wrap);
    }
    const badge = wrap.querySelector('.badge') as HTMLElement;
    const pct = Math.round(result.confidence * 100);
    badge.textContent = `${text} · ${pct}%`;
    this.position(el, wrap);
  }

  private position(el: Element, wrap: HTMLElement): void {
    const r = el.getBoundingClientRect();
    const outline = wrap.querySelector('.outline') as HTMLElement;
    const badge = wrap.querySelector('.badge') as HTMLElement;
    const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
    wrap.style.display = visible ? 'block' : 'none';
    outline.style.left = `${r.left}px`;
    outline.style.top = `${r.top}px`;
    outline.style.width = `${r.width}px`;
    outline.style.height = `${r.height}px`;
    badge.style.left = `${r.left}px`;
    badge.style.top = `${r.top}px`;
  }

  private scheduleReposition = (): void => {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      for (const [el, wrap] of this.badges) {
        if (!el.isConnected) {
          wrap.remove();
          this.badges.delete(el);
        } else {
          this.position(el, wrap);
        }
      }
    });
  };

  clear(): void {
    for (const wrap of this.badges.values()) wrap.remove();
    this.badges.clear();
    this.host?.remove();
    this.host = null;
    this.root = null;
  }
}

export const badgeLayer = new BadgeLayer();
