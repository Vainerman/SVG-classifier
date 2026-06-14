/**
 * Popup: enable toggle, MOCK banner, attribution mode, threshold, debug-badge
 * toggle, and live per-tab stats (queried from the active tab's content script).
 */
import { MOCK_MODE, type AttributionMode } from '@/shared/config';
import { normalizeDenylistEntry } from '@/shared/denylist';
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
  const debugLabelAll = $<HTMLInputElement>('debugLabelAll');
  const attribution = $<HTMLSelectElement>('attribution');
  const threshold = $<HTMLInputElement>('threshold');
  const thresholdOut = $<HTMLOutputElement>('thresholdOut');

  enabled.checked = settings.enabled;
  debugBadge.checked = settings.debugBadge;
  debugLabelAll.checked = settings.debugLabelAll;
  attribution.value = settings.attribution;
  threshold.value = String(settings.confidenceThreshold);
  thresholdOut.value = settings.confidenceThreshold.toFixed(2);

  enabled.addEventListener('change', () => setSettings({ enabled: enabled.checked }));
  debugBadge.addEventListener('change', () => setSettings({ debugBadge: debugBadge.checked }));
  debugLabelAll.addEventListener('change', () =>
    setSettings({ debugLabelAll: debugLabelAll.checked }),
  );
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

  await initDenylistToggle();
  await refreshStats();
}

/** "Disable on this site": adds/removes the active tab's host in the denylist. */
async function initDenylistToggle(): Promise<void> {
  const host = await activeTabHost();
  if (!host) return; // chrome://, extension pages, etc. — leave the row hidden.

  $('denylistHost').textContent = host;
  $('denylistRow').hidden = false;

  const box = $<HTMLInputElement>('denylistSite');
  const { siteDenylist } = await getSettings();
  box.checked = siteDenylist.some((e) => normalizeDenylistEntry(e) === host);

  box.addEventListener('change', async () => {
    const list = (await getSettings()).siteDenylist.filter(
      (e) => normalizeDenylistEntry(e) !== host,
    );
    if (box.checked) list.push(host);
    await setSettings({ siteDenylist: list });
  });
}

/** http(s) hostname of the active tab, or null when there's nothing to label. */
async function activeTabHost(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    const url = new URL(tab.url);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null;
  } catch {
    return null;
  }
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
