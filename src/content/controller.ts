/**
 * Content-script orchestrator. Wires discovery → free-label gate → extract/hash
 * → cache → rasterize → classify → aria injection, with dedup + batching.
 *
 * Flow per candidate (see plan):
 *   1. free-label gate (do-no-harm): hidden/named/named-by-ancestor → skip;
 *      free-label → write it; unlabeled → continue.
 *   2. extract + hash; mem-cache hit → write.
 *   3. enqueue under hash (dedup), debounce a flush.
 *   4. flush: IDB cache lookup → rasterize misses → batch classify → write all.
 */
import { BATCH, type BehaviorSettings } from '@/shared/config';
import { getSettings, onSettingsChanged } from '@/shared/settings';
import type {
  CacheLookupResponse,
  ClassifyItem,
  ClassifyResponse,
  ClassifyResult,
  ContentRequest,
  PipelineStats,
  PopupRequest,
  ReadoutItem,
  ReadoutResponse,
  StatsResponse,
} from '@/shared/messages';
import { Scanner } from '@/content/scanner';
import { isDenylisted } from '@/shared/denylist';
import { computeAccNameState, resolveFocusTarget } from '@/content/freeLabel';
import { extractIcon, type ExtractedIcon, type IconKind } from '@/content/extract';
import { rasterizeIcon } from '@/content/rasterize';
import { applyLabel, composeLabel, badgeLayer } from '@/content/overlay';
import { isHandled, markHandled, resetHandled } from '@/content/handled';
import { EphemeralInjector } from '@/content/ephemeral';
import { getCached, setCached } from '@/content/cache';

interface PendingEntry {
  kind: IconKind;
  nodes: Set<Element>;
  sample: Element;
}

interface NodeMeta {
  /** Existing accessible name/tag, shown in the debug badge ('' if none). */
  existing: string;
  /** false = debug-only: show a badge but never write aria (do-no-harm). */
  writeAria: boolean;
}

// Interaction events that cut a pending deferral short — the challenge has
// almost certainly resolved once the user touches the page.
const DEFER_INTERACTIONS = ['pointerdown', 'keydown', 'scroll'] as const;
const DEFER_LISTENER_OPTS: AddEventListenerOptions = {
  once: true,
  passive: true,
  capture: true,
};

export class Controller {
  private settings!: BehaviorSettings;
  private scanner: Scanner | null = null;
  /** Focus-driven on-demand injector (ephemeral mode). Lives for the page; armed
   *  while the controller is active, disarmed (no writes) otherwise. */
  private ephemeral = new EphemeralInjector();
  /** Cancels a pending deferred start (timer + interaction listeners); null when idle. */
  private deferCleanup: (() => void) | null = null;
  private pending = new Map<string, PendingEntry>();
  /** Per-node intent for a pending classification: the existing accessible name
   *  (debug "label all" badge) and whether to write aria. Badge-only nodes
   *  (writeAria=false) are visualized but never modified. */
  private nodeMeta = new WeakMap<Element, NodeMeta>();
  private flushTimer: number | null = null;
  /** Off-page readout for the popup: one renderable record per unique icon
   *  (deduped by hash). Populated as we classify; never touches the page. */
  private readout = new Map<string, ReadoutItem>();
  private readoutTruncated = false;
  private static readonly READOUT_CAP = 250;
  private stats: PipelineStats = {
    seen: 0,
    labeled: 0,
    skipped: 0,
    cacheHits: 0,
    unknown: 0,
  };

  async start(): Promise<void> {
    this.settings = await getSettings();
    onSettingsChanged((s) => this.onSettings(s));
    this.listenForStatsRequests();
    if (this.settings.enabled) this.enable();
  }

  private onSettings(next: BehaviorSettings): void {
    const modeChanged = this.settings?.injectionMode !== next.injectionMode;
    this.settings = next;
    // Re-evaluate against the new enabled flag AND a possibly-edited denylist.
    const running = this.scanner !== null || this.deferCleanup !== null;
    const shouldRun = next.enabled && this.shouldRunHere();
    if (shouldRun && !running) this.enable();
    else if (!shouldRun && running) this.disable();
    else if (shouldRun && running && modeChanged) {
      // Switching ephemeral⇄persistent: tear down, forget handled-state so every
      // candidate is reconsidered under the new strategy, then rebuild.
      this.disable();
      resetHandled();
      this.enable();
    }
    // Tear down badges only when BOTH debug visualizations are off.
    if (!next.debugBadge && !next.debugLabelAll) badgeLayer.clear();
  }

  /** Off entirely on denylisted hosts — bail before touching the page DOM. */
  private shouldRunHere(): boolean {
    return !isDenylisted(location.hostname, this.settings.siteDenylist);
  }

  private enable(): void {
    if (this.scanner || this.deferCleanup) return;
    if (!this.shouldRunHere()) return;
    if (this.settings.deferActivation) this.deferStart();
    else this.startScanner();
  }

  private startScanner(): void {
    this.clearDefer();
    if (this.scanner) return;
    // Ephemeral mode processes eagerly (labels must be ready before the user can
    // Tab to an off-screen control) and arms the focus-driven injector. Eager
    // processing makes NO DOM writes, so it costs no footprint.
    const eager = this.settings.injectionMode === 'ephemeral';
    if (eager) this.ephemeral.arm();
    // Fresh run → fresh readout.
    this.readout.clear();
    this.readoutTruncated = false;
    this.scanner = new Scanner((el) => this.onCandidate(el), { eager });
    this.scanner.start();
  }

  /** Wait for the page to settle (delay or first interaction) before scanning,
   *  so invisible bot challenges resolve before we mutate the DOM. */
  private deferStart(): void {
    const start = () => this.startScanner();
    const timer = setTimeout(start, Math.max(0, this.settings.deferDelayMs)) as unknown as number;
    for (const ev of DEFER_INTERACTIONS) {
      window.addEventListener(ev, start, DEFER_LISTENER_OPTS);
    }
    this.deferCleanup = () => {
      clearTimeout(timer);
      for (const ev of DEFER_INTERACTIONS) {
        window.removeEventListener(ev, start, DEFER_LISTENER_OPTS);
      }
      this.deferCleanup = null;
    };
  }

  private clearDefer(): void {
    this.deferCleanup?.();
  }

  private disable(): void {
    this.clearDefer();
    this.scanner?.stop();
    this.scanner = null;
    this.ephemeral.disarm();
    badgeLayer.clear();
  }

  private onCandidate(el: Element): void {
    if (isHandled(el)) return;
    this.stats.seen++;

    const acc = computeAccNameState(el, {
      useFreeLabelHints: this.settings.useFreeLabelHints,
    });
    const labelAll = this.settings.debugLabelAll;

    // Icons we normally leave untouched. In debug "label all" we still classify
    // them — badge-only — to show the model's guess next to the existing name.
    if (acc.state === 'hidden' || acc.state === 'named' || acc.state === 'named-by-ancestor') {
      this.stats.skipped++;
      if (labelAll) {
        this.observe(el, acc.existingName ?? '');
      } else {
        markHandled(el);
      }
      return;
    }

    const extracted = extractIcon(el);
    if (!extracted) {
      markHandled(el);
      return;
    }

    if (acc.state === 'free-label' && acc.freeLabel) {
      const result: ClassifyResult = {
        hash: extracted.hash,
        label: acc.freeLabel,
        confidence: 1,
        source: 'cache',
      };
      setCached(result);
      markHandled(el);
      this.noteReadout(extracted.hash, {
        src: this.renderSrc(el, extracted),
        kind: extracted.kind,
        label: acc.freeLabel,
        confidence: 1,
        source: 'free-label',
        state: 'labeled',
      });
      if (this.deliver(el, extracted.kind, result)) this.stats.labeled++;
      // In debug "label all", ALSO classify it badge-only so the adopted hint can
      // be compared against the model — without touching the aria we just wrote.
      if (labelAll) this.observe(el, acc.freeLabel);
      return;
    }

    // Mem-cache hit?
    const cached = getCached(extracted.hash);
    if (cached) {
      this.stats.cacheHits++;
      this.noteReadout(extracted.hash, { src: this.renderSrc(el, extracted), kind: extracted.kind });
      this.writeResult(el, extracted.kind, cached);
      return;
    }

    // Ephemeral mode: don't even classify icons nobody can focus — focus-driven
    // labeling can't reach them (they're Architecture B's job). Saves model work
    // and keeps the DOM untouched. Debug "label all" still classifies everything.
    if (this.settings.injectionMode === 'ephemeral' && !labelAll && !resolveFocusTarget(el)) {
      markHandled(el);
      this.stats.skipped++;
      return;
    }

    this.noteReadout(extracted.hash, {
      src: this.renderSrc(el, extracted),
      kind: extracted.kind,
      state: 'pending',
    });
    this.enqueue(el, extracted, { existing: '', writeAria: true });
    this.scheduleFlush();
  }

  /** Debug "label all": classify an icon we won't modify, to badge existing vs
   *  generated. Marks it handled so the scanner won't re-enqueue it. */
  private observe(el: Element, existing: string): void {
    const extracted = extractIcon(el);
    // Mark handled so the scanner won't re-enqueue it.
    if (!isHandled(el)) markHandled(el);
    if (!extracted) return;
    const cached = getCached(extracted.hash);
    if (cached) {
      badgeLayer.show(el, cached.label, cached, { existing, observed: true });
      return;
    }
    this.enqueue(el, extracted, { existing, writeAria: false });
    this.scheduleFlush();
  }

  /** Add a node to the pending batch (dedup by hash), recording its intent. */
  private enqueue(el: Element, extracted: { hash: string; kind: IconKind }, meta: NodeMeta): void {
    this.nodeMeta.set(el, meta);
    const entry = this.pending.get(extracted.hash);
    if (entry) {
      entry.nodes.add(el);
    } else {
      this.pending.set(extracted.hash, {
        kind: extracted.kind,
        nodes: new Set([el]),
        sample: el,
      });
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    if (this.pending.size >= BATCH.maxBatch) {
      void this.flush();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, BATCH.windowMs) as unknown as number;
  }

  private async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.size === 0) return;

    // Snapshot + clear so new candidates queue for the next flush.
    const batch = this.pending;
    this.pending = new Map();
    const hashes = [...batch.keys()];

    try {
      const { results: hits, misses } = await sendToBackground<CacheLookupResponse>({
        type: 'CACHE_LOOKUP',
        target: 'background',
        hashes,
      });

      for (const hit of hits) {
        this.stats.cacheHits++;
        setCached(hit);
        this.applyToEntry(batch.get(hit.hash), hit);
      }

      if (misses.length === 0) return;

      // Rasterize one representative per missing hash.
      const items: ClassifyItem[] = [];
      for (const hash of misses) {
        const entry = batch.get(hash);
        if (!entry) continue;
        const tensor = await rasterizeIcon(entry.sample, entry.kind);
        if (!tensor) {
          markHandled(entry.sample); // un-rasterizable (e.g. tainted) → leave alone
          continue;
        }
        items.push({ hash, tensor });
      }
      if (items.length === 0) return;

      const { results } = await sendToBackground<ClassifyResponse>({
        type: 'CLASSIFY_BATCH',
        target: 'background',
        items,
      });

      for (const result of results) {
        setCached(result);
        this.applyToEntry(batch.get(result.hash), result);
      }
    } catch (err) {
      console.debug('[icon-labeler] flush failed', err);
    }
  }

  private applyToEntry(entry: PendingEntry | undefined, result: ClassifyResult): void {
    if (!entry) return;
    for (const node of entry.nodes) this.writeResult(node, entry.kind, result);
  }

  private writeResult(el: Element, kind: IconKind, result: ClassifyResult): void {
    const meta = this.nodeMeta.get(el);
    this.nodeMeta.delete(el);

    // Debug "label all": an icon we won't modify — badge only, no aria, no stats
    // (it was already counted as skipped when discovered).
    if (meta && !meta.writeAria) {
      badgeLayer.show(el, result.label, result, { existing: meta.existing, observed: true });
      return;
    }

    // Abstain below threshold → no aria written (do-no-harm).
    if (result.label === 'unknown' || result.confidence < this.settings.confidenceThreshold) {
      markHandled(el);
      this.stats.unknown++;
      this.noteReadout(result.hash, {
        label: result.label,
        confidence: result.confidence,
        source: result.source,
        state: 'low',
      });
      // Still surface the model's (below-threshold) guess when labeling all.
      if (this.settings.debugLabelAll) {
        badgeLayer.show(el, result.label, result, { existing: meta?.existing ?? '', observed: true });
      }
      return;
    }
    markHandled(el);
    this.noteReadout(result.hash, {
      label: result.label,
      confidence: result.confidence,
      source: result.source,
      state: 'labeled',
    });
    if (this.deliver(el, kind, result)) this.stats.labeled++;
  }

  /** Renderable image source for the popup readout: a self-contained data: URI
   *  for inline/sprite SVG (canonical already has <use> inlined), or the original
   *  src for an <img>. Used only for the off-page popup view. */
  private renderSrc(el: Element, extracted: ExtractedIcon): string {
    if (extracted.kind === 'img-svg') {
      return (el as HTMLImageElement).getAttribute('src') ?? '';
    }
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(extracted.canonical);
  }

  /** Insert-or-merge a readout record (deduped by hash). Capped to bound the
   *  message size; sets the truncation flag once full. */
  private noteReadout(hash: string, patch: Partial<ReadoutItem>): void {
    const existing = this.readout.get(hash);
    if (existing) {
      this.readout.set(hash, { ...existing, ...patch });
      return;
    }
    if (this.readout.size >= Controller.READOUT_CAP) {
      this.readoutTruncated = true;
      return;
    }
    this.readout.set(hash, {
      src: patch.src ?? '',
      kind: patch.kind ?? 'inline-svg',
      label: patch.label ?? '',
      confidence: patch.confidence ?? 0,
      source: patch.source ?? '',
      state: patch.state ?? 'pending',
    });
  }

  /** Apply a label via the configured strategy. Persistent → write into the DOM
   *  now; ephemeral → register for focus-driven injection. True if delivered. */
  private deliver(el: Element, kind: IconKind, result: ClassifyResult): boolean {
    if (this.settings.injectionMode === 'ephemeral') {
      return this.deliverEphemeral(el, result);
    }
    return applyLabel(el, kind, result, this.settings);
  }

  private deliverEphemeral(el: Element, result: ClassifyResult): boolean {
    const target = resolveFocusTarget(el);
    if (!target) return false; // not keyboard-focusable → unreachable (Architecture B)
    const { accessibleName, badgeText } = composeLabel(result.label, this.settings);
    // role="img" only when the icon itself is the focus target; never on a real
    // control (a <button>/<a> already carries the correct role).
    const needsRoleImg = target === el && el.tagName.toLowerCase() === 'svg';
    this.ephemeral.register(target, accessibleName, needsRoleImg);
    if (this.settings.debugBadge || this.settings.debugLabelAll) {
      badgeLayer.show(el, badgeText, result);
    }
    return true;
  }

  private listenForStatsRequests(): void {
    chrome.runtime.onMessage.addListener(
      (msg: PopupRequest, _sender, sendResponse: (r: StatsResponse | ReadoutResponse) => void) => {
        if (msg?.type === 'GET_STATS' && msg.target === 'content') {
          sendResponse({ stats: this.stats });
        } else if (msg?.type === 'GET_READOUT' && msg.target === 'content') {
          sendResponse({
            stats: this.stats,
            items: [...this.readout.values()],
            truncated: this.readoutTruncated,
          });
        }
        // Not returning true: synchronous response, channel closes immediately.
      },
    );
  }
}

async function sendToBackground<T>(msg: ContentRequest): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}
