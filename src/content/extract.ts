/**
 * SVG discovery + normalization + <use> sprite resolution + hashing.
 *
 * Produces a STABLE canonical string per icon so visually-identical icons that
 * differ only in volatile attributes (ids, classes, inline transforms we add,
 * whitespace) hash to the same value and are deduped.
 */
import { fnv1a } from '@/shared/hash';
import { SENTINEL_ATTR, OWNED_ATTRS } from '@/shared/config';

export type IconKind = 'inline-svg' | 'sprite-svg' | 'img-svg';

export interface ExtractedIcon {
  kind: IconKind;
  /** The DOM node we write the aria label onto. */
  targetNode: Element;
  /** Stable canonical string used for hashing/dedup. */
  canonical: string;
  hash: string;
}

// Attributes stripped during normalization (volatile / non-shape).
const VOLATILE_ATTRS = new Set<string>([
  'id',
  'class',
  'style',
  'width',
  'height',
  'tabindex',
  'focusable',
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-hidden',
  'aria-roledescription',
  SENTINEL_ATTR,
  ...OWNED_ATTRS,
]);

function isVolatile(name: string): boolean {
  return VOLATILE_ATTRS.has(name) || name.startsWith('data-') || name.startsWith('aria-');
}

/** Resolve <use href="#id"> against in-document <symbol>/<g>/defs, inlining geometry.
 *  Exported so rasterization can inline the same geometry (else a standalone
 *  sprite SVG renders blank — its symbol lives in the page document). */
export function resolveUses(svg: SVGElement): void {
  const doc = svg.ownerDocument;
  const uses = Array.from(svg.querySelectorAll('use'));
  for (const use of uses) {
    const href =
      use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
    if (!href.startsWith('#')) continue; // external sprite: left as-is (hashed by href)
    const ref = doc.getElementById(href.slice(1));
    if (!ref) continue;
    const clone = ref.cloneNode(true) as Element;
    // <symbol> isn't rendered directly; promote its children in place.
    if (clone.tagName.toLowerCase() === 'symbol') {
      const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
      while (clone.firstChild) g.appendChild(clone.firstChild);
      use.replaceWith(g);
    } else {
      use.replaceWith(clone);
    }
  }
}

/** Recursively strip volatile attributes and sort the rest for stability. */
function normalizeNode(el: Element): void {
  const names = el.getAttributeNames();
  // Collect kept attrs, then re-apply sorted.
  const kept: Array<[string, string]> = [];
  for (const name of names) {
    if (isVolatile(name)) {
      el.removeAttribute(name);
    } else {
      kept.push([name, el.getAttribute(name) ?? '']);
      el.removeAttribute(name);
    }
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, value] of kept) el.setAttribute(name, value);

  for (const child of Array.from(el.children)) normalizeNode(child);
}

/** Build the canonical string for an inline / sprite SVG. */
export function canonicalizeSvg(svg: SVGElement): string {
  const clone = svg.cloneNode(true) as SVGElement;
  resolveUses(clone);
  normalizeNode(clone);
  const raw = new XMLSerializer().serializeToString(clone);
  // Collapse inter-tag whitespace and trim.
  return raw.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
}

function hasSpriteUse(svg: SVGElement): boolean {
  return svg.querySelector('use') !== null;
}

/** Normalize an <img> SVG to a stable identity (src; data: URIs included). */
function canonicalizeImg(img: HTMLImageElement): string {
  const src = img.getAttribute('src') ?? '';
  // data:image/svg+xml,... → hash the payload; external/same-origin → hash URL.
  return `img:${src}`;
}

/**
 * Extract a canonical icon from a candidate node, or null if it isn't a
 * supported icon. Synchronous — <img> SVG bytes are not fetched (we hash the
 * src; cross-origin fetch is a deferred concern).
 */
export function extractIcon(el: Element): ExtractedIcon | null {
  const tag = el.tagName.toLowerCase();

  if (tag === 'svg') {
    const svg = el as unknown as SVGElement;
    const kind: IconKind = hasSpriteUse(svg) ? 'sprite-svg' : 'inline-svg';
    const canonical = canonicalizeSvg(svg);
    return { kind, targetNode: el, canonical, hash: fnv1a(canonical) };
  }

  if (tag === 'img') {
    const img = el as HTMLImageElement;
    const canonical = canonicalizeImg(img);
    return { kind: 'img-svg', targetNode: el, canonical, hash: fnv1a(canonical) };
  }

  return null;
}
