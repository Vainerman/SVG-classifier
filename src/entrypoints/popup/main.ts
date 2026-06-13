/**
 * Popup: enable toggle, MOCK banner, attribution mode, threshold, debug-badge
 * toggle, and live per-tab stats (queried from the active tab's content script).
 */
import { MOCK_MODE, type AttributionMode } from '@/shared/config';
import { getSettings, setSettings } from '@/shared/settings';
import type { PopupRequest, StatsResponse } from '@/shared/messages';

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

async function init(): Promise<void> {
  if (MOCK_MODE) $('mockBanner').hidden = false;

  const settings = await getSettings();
  const enabled = $<HTMLInputElement>('enabled');
  const debugBadge = $<HTMLInputElement>('debugBadge');
  const attribution = $<HTMLSelectElement>('attribution');
  const threshold = $<HTMLInputElement>('threshold');
  const thresholdOut = $<HTMLOutputElement>('thresholdOut');

  enabled.checked = settings.enabled;
  debugBadge.checked = settings.debugBadge;
  attribution.value = settings.attribution;
  threshold.value = String(settings.confidenceThreshold);
  thresholdOut.value = settings.confidenceThreshold.toFixed(2);

  enabled.addEventListener('change', () => setSettings({ enabled: enabled.checked }));
  debugBadge.addEventListener('change', () => setSettings({ debugBadge: debugBadge.checked }));
  attribution.addEventListener('change', () =>
    setSettings({ attribution: attribution.value as AttributionMode }),
  );
  threshold.addEventListener('input', () => {
    thresholdOut.value = Number(threshold.value).toFixed(2);
  });
  threshold.addEventListener('change', () =>
    setSettings({ confidenceThreshold: Number(threshold.value) }),
  );

  $('optionsLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  await refreshStats();
}

async function refreshStats(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const req: PopupRequest = { type: 'GET_STATS', target: 'content' };
    const resp = (await chrome.tabs.sendMessage(tab.id, req)) as StatsResponse | undefined;
    if (!resp) return;
    const { stats } = resp;
    $('statSeen').textContent = String(stats.seen);
    $('statLabeled').textContent = String(stats.labeled);
    $('statSkipped').textContent = String(stats.skipped);
    $('statCache').textContent = String(stats.cacheHits);
    $('statUnknown').textContent = String(stats.unknown);
  } catch {
    // No content script on this page (e.g. chrome:// or the page isn't ready).
  }
}

void init();
