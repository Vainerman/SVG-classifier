/**
 * Discovery: IntersectionObserver (visible-first) + MutationObserver (dynamic /
 * SPA). Emits each candidate icon exactly once, when it scrolls into view.
 *
 * Self-loop guard: writing aria-label/role/alt/sentinel would otherwise refire
 * the MutationObserver forever. We ignore attribute mutations to our OWNED_ATTRS
 * and skip any node already carrying the sentinel.
 */
import { OWNED_ATTRS, SENTINEL_ATTR } from '@/shared/config';

const OWNED = new Set<string>(OWNED_ATTRS);

// Candidate icons: inline/sprite <svg>, and <img> whose source looks like SVG.
const IMG_SVG_SELECTOR =
  'img[src$=".svg" i],img[src*=".svg?" i],img[src^="data:image/svg+xml" i]';
const CANDIDATE_SELECTOR = `svg,${IMG_SVG_SELECTOR}`;

export type CandidateHandler = (el: Element) => void;

export class Scanner {
  private io: IntersectionObserver;
  private mos: MutationObserver[] = [];
  private observedRoots = new WeakSet<Node>();
  private queued = new WeakSet<Element>();

  constructor(private readonly onCandidate: CandidateHandler) {
    this.io = new IntersectionObserver(this.onIntersect, { rootMargin: '100px' });
  }

  start(): void {
    this.scanRoot(document);
    this.observeMutations(document);
  }

  stop(): void {
    this.io.disconnect();
    for (const mo of this.mos) mo.disconnect();
    this.mos = [];
  }

  /** Find candidates under a root (descending into open shadow roots). */
  private scanRoot(root: Document | ShadowRoot | Element): void {
    let matches: Element[] = [];
    try {
      matches = Array.from(
        (root as Element | Document).querySelectorAll(CANDIDATE_SELECTOR),
      );
    } catch {
      /* querySelectorAll can throw on exotic selectors in old engines */
    }
    for (const el of matches) this.consider(el);

    // Descend into open shadow roots.
    const hosts = (root as Element | Document).querySelectorAll('*');
    for (const host of Array.from(hosts)) {
      const sr = (host as Element).shadowRoot;
      if (sr && !this.observedRoots.has(sr)) {
        this.scanRoot(sr);
        this.observeMutations(sr);
      }
    }
  }

  private consider(el: Element): void {
    if (this.queued.has(el)) return;
    if (el.hasAttribute(SENTINEL_ATTR)) return;
    // Nested <svg> inside an <svg> (e.g. <use> targets): only the outermost counts.
    if (el.tagName.toLowerCase() === 'svg' && el.parentElement?.closest('svg')) {
      return;
    }
    this.queued.add(el);
    this.io.observe(el);
  }

  private onIntersect = (entries: IntersectionObserverEntry[]): void => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      this.io.unobserve(el);
      if (!el.hasAttribute(SENTINEL_ATTR)) this.onCandidate(el);
    }
  };

  private observeMutations(root: Document | ShadowRoot): void {
    if (this.observedRoots.has(root)) return;
    this.observedRoots.add(root);
    const target =
      root instanceof Document ? root.documentElement : (root as ShadowRoot);
    if (!target) return;
    const mo = new MutationObserver(this.onMutations);
    mo.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'class'], // re-eval icons whose source/class changed
    });
    this.mos.push(mo);
  }

  private onMutations = (records: MutationRecord[]): void => {
    for (const rec of records) {
      // Ignore mutations we caused.
      if (rec.type === 'attributes') {
        if (rec.attributeName && OWNED.has(rec.attributeName)) continue;
        if (
          rec.target instanceof Element &&
          rec.target.getAttribute(SENTINEL_ATTR)
        ) {
          continue;
        }
      }
      if (rec.type === 'childList') {
        for (const node of Array.from(rec.addedNodes)) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          this.scanSubtree(node as Element);
        }
      } else if (rec.type === 'attributes' && rec.target instanceof Element) {
        // src/class changed on an existing candidate → reconsider it.
        if (rec.target.matches?.(CANDIDATE_SELECTOR)) this.consider(rec.target);
      }
    }
  };

  private scanSubtree(el: Element): void {
    if (el.matches?.(CANDIDATE_SELECTOR)) this.consider(el);
    this.scanRoot(el);
  }
}
