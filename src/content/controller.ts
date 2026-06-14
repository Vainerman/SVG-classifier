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
  StatsResponse,
} from '@/shared/messages';
import { Scanner } from '@/content/scanner';
import { isDenylisted } from '@/shared/denylist';
import { computeAccNameState } from '@/content/freeLabel';
import { extractIcon, type IconKind } from '@/content/extract';
import { rasterizeIcon } from '@/content/rasterize';
import { applyLabel, markSkipped, isHandled, badgeLayer } from '@/content/overlay';
import { getCached, setCached } from '@/content/cache';

interface PendingEntry {
  kind: IconKind;
  nodes: Set<Element>;
  sample: Element;
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
  /** Cancels a pending deferred start (timer + interaction listeners); null when idle. */
  private deferCleanup: (() => void) | null = null;
  private pending = new Map<string, PendingEntry>();
  private flushTimer: number | null = null;
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
    this.settings = next;
    // Re-evaluate against the new enabled flag AND a possibly-edited denylist.
    const running = this.scanner !== null || this.deferCleanup !== null;
    const shouldRun = next.enabled && this.shouldRunHere();
    if (shouldRun && !running) this.enable();
    else if (!shouldRun && running) this.disable();
    if (!next.debugBadge) badgeLayer.clear();
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
    this.scanner = new Scanner((el) => this.onCandidate(el));
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
    badgeLayer.clear();
  }

  private onCandidate(el: Element): void {
    if (isHandled(el)) return;
    this.stats.seen++;

    const acc = computeAccNameState(el, {
      useFreeLabelHints: this.settings.useFreeLabelHints,
    });

    if (acc.state === 'hidden' || acc.state === 'named' || acc.state === 'named-by-ancestor') {
      markSkipped(el);
      this.stats.skipped++;
      return;
    }

    const extracted = extractIcon(el);
    if (!extracted) {
      markSkipped(el);
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
      if (applyLabel(el, extracted.kind, result, this.settings)) this.stats.labeled++;
      return;
    }

    // Mem-cache hit?
    const cached = getCached(extracted.hash);
    if (cached) {
      this.stats.cacheHits++;
      this.writeResult(el, extracted.kind, cached);
      return;
    }

    // Enqueue for batched classification (dedup by hash).
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
    this.scheduleFlush();
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
          markSkipped(entry.sample); // un-rasterizable (e.g. tainted) → leave alone
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
    // Abstain below threshold → no aria written (do-no-harm).
    if (result.label === 'unknown' || result.confidence < this.settings.confidenceThreshold) {
      markSkipped(el);
      this.stats.unknown++;
      return;
    }
    if (applyLabel(el, kind, result, this.settings)) this.stats.labeled++;
  }

  private listenForStatsRequests(): void {
    chrome.runtime.onMessage.addListener(
      (msg: PopupRequest, _sender, sendResponse: (r: StatsResponse) => void) => {
        if (msg?.type === 'GET_STATS' && msg.target === 'content') {
          sendResponse({ stats: this.stats });
        }
        // Not returning true: synchronous response, channel closes immediately.
      },
    );
  }
}

async function sendToBackground<T>(msg: ContentRequest): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}
