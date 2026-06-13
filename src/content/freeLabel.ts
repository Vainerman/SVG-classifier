/**
 * The do-no-harm accessibility core. For each candidate icon it decides whether
 * the icon ALREADY has an accessible name a screen reader will announce — if so
 * we leave it completely alone. Mislabeling an already-accessible icon is a
 * regression that degrades a working page, which is worse than doing nothing.
 *
 * Implements a pragmatic, icon-scoped subset of the ACCNAME (Accessible Name and
 * Description) computation, including the ANCESTOR-CONTEXT check that prevents
 * screen-reader "double-speak" (icon inside an already-named button/link).
 *
 * Pure DOM-in / decision-out: the highest-value unit-test surface.
 */

export type AccNameState =
  | 'hidden' // author-decorative or not rendered → never label
  | 'named' // already has its own accessible name → leave alone
  | 'named-by-ancestor' // inside an already-named control → would double-speak
  | 'free-label' // trustworthy class/data/filename hint → use it, skip the model
  | 'unlabeled'; // genuinely unlabeled → rasterize + classify

export interface FreeLabelResult {
  state: AccNameState;
  /** Present only for state === 'free-label'. */
  freeLabel?: string;
}

export interface FreeLabelOptions {
  /** Adopt class="icon-home" / data-icon / filename hints (settings.useFreeLabelHints). */
  useFreeLabelHints: boolean;
}

const INTERACTIVE_TAGS = new Set(['button', 'a', 'summary']);
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'option',
  'treeitem',
]);

function attr(el: Element, name: string): string {
  return (el.getAttribute(name) ?? '').trim();
}

function isElementHidden(el: Element): boolean {
  // aria-hidden anywhere up the chain removes the subtree from the a11y tree.
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (attr(n, 'aria-hidden') === 'true') return true;
  }
  // role=presentation/none on the icon itself = explicitly decorative.
  const role = attr(el, 'role');
  if (role === 'presentation' || role === 'none') return true;
  // display:none / visibility:hidden → not rendered, no point labeling.
  try {
    const style = el.ownerDocument?.defaultView?.getComputedStyle(el);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) {
      return true;
    }
  } catch {
    /* getComputedStyle may throw in detached/jsdom contexts — treat as visible */
  }
  return false;
}

/** Resolve aria-labelledby to concatenated referenced text. */
function labelledByText(el: Element): string {
  const ids = attr(el, 'aria-labelledby');
  if (!ids) return '';
  const doc = el.ownerDocument;
  return ids
    .split(/\s+/)
    .map((id) => doc.getElementById(id)?.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
    .trim();
}

/** Does the element carry its own accessible name (ignoring descendant icons)? */
function ownName(el: Element): string {
  const ariaLabel = attr(el, 'aria-label');
  if (ariaLabel) return ariaLabel;
  const lb = labelledByText(el);
  if (lb) return lb;
  // SVG's accessible name comes from a direct <title> child.
  if (el.tagName.toLowerCase() === 'svg') {
    const title = Array.from(el.children).find(
      (c) => c.tagName.toLowerCase() === 'title',
    );
    if (title?.textContent?.trim()) return title.textContent.trim();
  }
  // <img alt> — note: alt="" (present but empty) is intentional decorative,
  // handled as `hidden` by the caller via altState().
  if (el.tagName.toLowerCase() === 'img') {
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
  }
  // title attribute is a (weak) accessible-name fallback / tooltip.
  const titleAttr = attr(el, 'title');
  if (titleAttr) return titleAttr;
  return '';
}

/** Visible text of an element EXCLUDING any descendant svg/img icons. */
function visibleTextExcludingIcons(el: Element): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = (node as Element).tagName.toLowerCase();
      if (tag === 'svg' || tag === 'img') continue;
      text += visibleTextExcludingIcons(node as Element);
    }
  }
  return text.trim();
}

function nearestInteractiveAncestor(el: Element): Element | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const tag = n.tagName.toLowerCase();
    if (tag === 'a' && n.hasAttribute('href')) return n;
    if (INTERACTIVE_TAGS.has(tag) && tag !== 'a') return n;
    if (INTERACTIVE_ROLES.has(attr(n, 'role'))) return n;
  }
  return null;
}

/** Extract a label from class="icon-home" / data-icon="home" / file name. */
function freeLabelHint(el: Element): string | undefined {
  const dataIcon = attr(el, 'data-icon');
  if (dataIcon) return normalizeHint(dataIcon);

  const cls = attr(el, 'class');
  // icon-home, icon_home, fa-home, glyph-home, co-home …
  const m = cls.match(/(?:^|[\s])(?:icon|fa|glyph|bi|mi|co|ico)[-_]([a-z][a-z0-9-]+)/i);
  if (m) return normalizeHint(m[1]);

  if (el.tagName.toLowerCase() === 'img') {
    const src = attr(el, 'src');
    const file = src.split(/[?#]/)[0].split('/').pop() ?? '';
    const base = file.replace(/\.svg$/i, '');
    if (base && /^[a-z0-9_-]+$/i.test(base)) return normalizeHint(base);
  }
  return undefined;
}

function normalizeHint(raw: string): string {
  return raw.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

/**
 * The decision function. `el` is the candidate icon node (inline <svg>, the
 * wrapping <svg> of a <use>, or an <img> of an SVG).
 */
export function computeAccNameState(
  el: Element,
  opts: FreeLabelOptions,
): FreeLabelResult {
  const tag = el.tagName.toLowerCase();

  // 1. Hidden / decorative.
  if (isElementHidden(el)) return { state: 'hidden' };
  // <img alt=""> (present but empty) is intentional decorative.
  if (tag === 'img' && el.getAttribute('alt') === '') return { state: 'hidden' };

  // 2. Already has its own accessible name.
  if (ownName(el)) return { state: 'named' };

  // 3. Inside an interactive ancestor that is already named by OTHER means →
  //    labeling the icon would double-speak.
  const ancestor = nearestInteractiveAncestor(el);
  if (ancestor) {
    const ancestorHasName =
      Boolean(ownName(ancestor)) ||
      Boolean(visibleTextExcludingIcons(ancestor)) ||
      hasOtherTitledIcon(ancestor, el);
    if (ancestorHasName) return { state: 'named-by-ancestor' };
    // else: the icon is the control's only content → it SHOULD supply the name.
  }

  // 4. Trustworthy free-label hint.
  if (opts.useFreeLabelHints) {
    const hint = freeLabelHint(el);
    if (hint) return { state: 'free-label', freeLabel: hint };
  }

  // 5. Genuinely unlabeled.
  return { state: 'unlabeled' };
}

/** Is there ANOTHER icon under `ancestor` (not `self`) that already has a name? */
function hasOtherTitledIcon(ancestor: Element, self: Element): boolean {
  const icons = ancestor.querySelectorAll('svg, img');
  for (const icon of Array.from(icons)) {
    if (icon === self) continue;
    if (ownName(icon)) return true;
  }
  return false;
}
