/**
 * Settings persistence via chrome.storage.local. Read directly by the content
 * script, popup, and options page (content scripts can use chrome.storage), so
 * settings do NOT round-trip through the service worker.
 */
import {
  DEFAULT_BEHAVIOR,
  STORAGE_KEY,
  type BehaviorSettings,
} from '@/shared/config';

export async function getSettings(): Promise<BehaviorSettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_BEHAVIOR, ...(stored[STORAGE_KEY] as Partial<BehaviorSettings> | undefined) };
}

export async function setSettings(
  patch: Partial<BehaviorSettings>,
): Promise<BehaviorSettings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** Subscribe to live settings changes (e.g. popup toggle). Returns an unsubscribe fn. */
export function onSettingsChanged(
  cb: (settings: BehaviorSettings) => void,
): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      cb({ ...DEFAULT_BEHAVIOR, ...(changes[STORAGE_KEY].newValue as Partial<BehaviorSettings>) });
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
