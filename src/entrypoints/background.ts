/**
 * Service worker: message broker + IndexedDB cross-page cache + offscreen
 * document lifecycle owner. No DOM, no model. (Plan §4.2.)
 */
import { defineBackground } from 'wxt/utils/define-background';
import { DEFAULT_BEHAVIOR } from '@/shared/config';
import { getSettings } from '@/shared/settings';
import { idbGet, idbPut, idbEvictIfOver } from '@/shared/idb';
import type {
  CacheLookupResponse,
  ClassifyResponse,
  ClassifyResult,
  ContentRequest,
  OffscreenClassifyResponse,
  OffscreenRequest,
} from '@/shared/messages';

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, sendResponse) => {
    if (msg?.target !== 'background') return; // ignore offscreen/content-targeted msgs

    if (msg.type === 'CACHE_LOOKUP') {
      handleCacheLookup(msg.hashes).then(sendResponse);
      return true; // async response
    }
    if (msg.type === 'CLASSIFY_BATCH') {
      handleClassify(msg.items).then(sendResponse);
      return true;
    }
    return undefined;
  });
});

async function handleCacheLookup(hashes: string[]): Promise<CacheLookupResponse> {
  try {
    return await idbGet(hashes);
  } catch (err) {
    console.debug('[icon-labeler] idb lookup failed', err);
    return { results: [], misses: hashes };
  }
}

async function handleClassify(items: OffscreenRequest['items']): Promise<ClassifyResponse> {
  if (items.length === 0) return { results: [] };
  const results = await classifyViaOffscreen(items);
  // Persist to the cross-page cache (best-effort).
  try {
    await idbPut(results);
    const { idbMaxEntries } = await safeSettings();
    await idbEvictIfOver(idbMaxEntries);
  } catch (err) {
    console.debug('[icon-labeler] idb put failed', err);
  }
  return { results };
}

async function safeSettings() {
  try {
    return await getSettings();
  } catch {
    return DEFAULT_BEHAVIOR;
  }
}

// ── Offscreen lifecycle ──────────────────────────────────────────────────────
const OFFSCREEN_URL = 'offscreen.html';
let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  // hasDocument is the canonical single-document guard.
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS' as chrome.offscreen.Reason],
        justification:
          'Runs the on-device icon classifier; MV3 service workers cannot access WASM/WebGPU.',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

const MAX_OFFSCREEN_ATTEMPTS = 4;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function classifyViaOffscreen(
  items: OffscreenRequest['items'],
  attempt = 0,
): Promise<ClassifyResult[]> {
  await ensureOffscreen();
  const req: OffscreenRequest = { type: 'OFFSCREEN_CLASSIFY', target: 'offscreen', items };
  try {
    const resp = (await chrome.runtime.sendMessage(req)) as OffscreenClassifyResponse | undefined;
    if (!resp) throw new Error('no response from offscreen document');
    return resp.results;
  } catch (err) {
    // Two cases land here, both retryable (items are idempotent — keyed by hash):
    //  - the doc was just created and hasn't registered its listener yet;
    //  - the browser tore the doc down between ensure() and send().
    if (attempt < MAX_OFFSCREEN_ATTEMPTS) {
      if (!(await chrome.offscreen.hasDocument())) creating = null; // force recreate
      await delay(60);
      return classifyViaOffscreen(items, attempt + 1);
    }
    console.warn('[icon-labeler] offscreen classification failed', err);
    return [];
  }
}
