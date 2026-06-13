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
  const useFreeLabelHints = $<HTMLInputElement>('useFreeLabelHints');
  const attributionText = $<HTMLInputElement>('attributionText');
  const idbMaxEntries = $<HTMLInputElement>('idbMaxEntries');

  useFreeLabelHints.checked = settings.useFreeLabelHints;
  attributionText.value = settings.attributionText;
  idbMaxEntries.value = String(settings.idbMaxEntries);

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

  $('clearCache').addEventListener('click', async () => {
    await idbClear();
    flashSaved();
  });
}

void init();
