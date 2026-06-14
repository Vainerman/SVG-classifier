/**
 * Popup: enable toggle, MOCK banner, attribution mode, threshold, debug-badge
 * toggle, and live per-tab stats (queried from the active tab's content script).
 */
import { MOCK_MODE, type AttributionMode } from '@/shared/config';
import { normalizeDenylistEntry } from '@/shared/denylist';
import { getSettings, setSettings } from '@/shared/settings';
import type {
  PopupRequest,
  ReadoutItem,
  ReadoutResponse,
  StatsResponse,
} from '@/shared/messages';

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

  $('readoutRefresh').addEventListener('click', () => {
    void refreshStats();
    void refreshReadout();
  });

  await initDenylistToggle();
  await refreshStats();
  await refreshReadout();
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

/** Pull the off-page icon readout (icon image + label) from the content script
 *  and render it in the popup. Nothing here touches the inspected page. */
async function refreshReadout(): Promise<void> {
  const list = $('readoutList');
  const empty = $('readoutEmpty');
  const trunc = $('readoutTrunc');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const req: PopupRequest = { type: 'GET_READOUT', target: 'content' };
    const resp = (await chrome.tabs.sendMessage(tab.id, req)) as ReadoutResponse | undefined;
    if (!resp) return;

    renderReadout(resp.items);
    const has = resp.items.length > 0;
    list.hidden = !has;
    empty.hidden = has;
    if (resp.truncated) {
      trunc.hidden = false;
      trunc.textContent = `Showing the first ${resp.items.length} icons (more were detected).`;
    } else {
      trunc.hidden = true;
    }
  } catch {
    // No content script on this page.
  }
}

function renderReadout(items: ReadoutItem[]): void {
  const list = $('readoutList');
  list.textContent = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `ricon ${item.state}`;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const img = document.createElement('img');
    // SVG loaded via <img> cannot execute scripts, so page-derived markup is safe
    // to render here. src is set as a property (never innerHTML).
    img.src = item.src;
    img.alt = '';
    img.loading = 'lazy';
    thumb.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.textContent =
      item.label || (item.state === 'pending' ? '…classifying' : 'unlabeled');
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${item.kind.replace('-svg', '')} · ${item.source || '—'}`;
    meta.appendChild(lbl);
    meta.appendChild(sub);

    const conf = document.createElement('div');
    conf.className = 'conf';
    conf.textContent = item.state === 'pending' ? '' : `${Math.round(item.confidence * 100)}%`;

    row.appendChild(thumb);
    row.appendChild(meta);
    row.appendChild(conf);
    list.appendChild(row);
  }
}

void init();
