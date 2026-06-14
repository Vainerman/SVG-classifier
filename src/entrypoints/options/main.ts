/**
 * Options page: advanced settings + clear result cache. IndexedDB is per-origin,
 * so this extension page can clear the same DB the service worker writes.
 */
import { getSettings, setSettings } from '@/shared/settings';
import { idbClear } from '@/shared/idb';

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function flashSaved(): void {
  const el = $('saved');
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 1200);
}

async function init(): Promise<void> {
  const settings = await getSettings();
  const ephemeralMode = $<HTMLInputElement>('ephemeralMode');
  const useFreeLabelHints = $<HTMLInputElement>('useFreeLabelHints');
  const attributionText = $<HTMLInputElement>('attributionText');
  const idbMaxEntries = $<HTMLInputElement>('idbMaxEntries');
  const siteDenylist = $<HTMLTextAreaElement>('siteDenylist');
  const safeModeSites = $<HTMLTextAreaElement>('safeModeSites');
  const deferActivation = $<HTMLInputElement>('deferActivation');
  const deferDelayMs = $<HTMLInputElement>('deferDelayMs');

  ephemeralMode.checked = settings.injectionMode === 'ephemeral';
  useFreeLabelHints.checked = settings.useFreeLabelHints;
  attributionText.value = settings.attributionText;
  idbMaxEntries.value = String(settings.idbMaxEntries);
  siteDenylist.value = settings.siteDenylist.join('\n');
  safeModeSites.value = settings.safeModeSites.join('\n');
  deferActivation.checked = settings.deferActivation;
  deferDelayMs.value = String(settings.deferDelayMs);

  ephemeralMode.addEventListener('change', async () => {
    await setSettings({
      injectionMode: ephemeralMode.checked ? 'ephemeral' : 'persistent',
    });
    flashSaved();
  });
  useFreeLabelHints.addEventListener('change', async () => {
    await setSettings({ useFreeLabelHints: useFreeLabelHints.checked });
    flashSaved();
  });
  attributionText.addEventListener('change', async () => {
    await setSettings({ attributionText: attributionText.value });
    flashSaved();
  });
  idbMaxEntries.addEventListener('change', async () => {
    const n = Math.max(100, Number(idbMaxEntries.value) || 100);
    idbMaxEntries.value = String(n);
    await setSettings({ idbMaxEntries: n });
    flashSaved();
  });
  siteDenylist.addEventListener('change', async () => {
    const list = siteDenylist.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    siteDenylist.value = list.join('\n');
    await setSettings({ siteDenylist: list });
    flashSaved();
  });
  safeModeSites.addEventListener('change', async () => {
    const list = safeModeSites.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    safeModeSites.value = list.join('\n');
    await setSettings({ safeModeSites: list });
    flashSaved();
  });
  deferActivation.addEventListener('change', async () => {
    await setSettings({ deferActivation: deferActivation.checked });
    flashSaved();
  });
  deferDelayMs.addEventListener('change', async () => {
    const n = Math.max(0, Number(deferDelayMs.value) || 0);
    deferDelayMs.value = String(n);
    await setSettings({ deferDelayMs: n });
    flashSaved();
  });

  $('clearCache').addEventListener('click', async () => {
    await idbClear();
    flashSaved();
  });
}

void init();
