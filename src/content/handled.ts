/**
 * Off-DOM "have we already processed this node?" registry.
 *
 * Replaces the old `data-icon-labeler` DOM sentinel attribute. Bot-detection
 * integrity monitors hash the page DOM; spraying a sentinel attribute across
 * every labeled AND skipped icon was gratuitous tampering with zero product
 * value. The handled-state lives entirely in a WeakSet instead — invisible to
 * the page, and auto-GC'd when a node detaches.
 *
 * `resetHandled` swaps in a fresh set so a mode switch (ephemeral⇄persistent)
 * can cleanly re-process every candidate.
 */
let handled = new WeakSet<Element>();

export function isHandled(el: Element): boolean {
  return handled.has(el);
}

export function markHandled(el: Element): void {
  handled.add(el);
}

export function resetHandled(): void {
  handled = new WeakSet<Element>();
}
