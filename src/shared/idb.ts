/**
 * Minimal IndexedDB wrapper for the cross-page result cache (used by the service
 * worker). One object store keyed by SVG hash. Records are namespaced by
 * CONFIG_VERSION so a preprocessing change can't serve stale labels.
 */
import { CONFIG_VERSION } from '@/shared/config';
import type { ClassifyResult } from '@/shared/messages';

const DB_NAME = 'icon-labeler';
const DB_VERSION = 1;
const STORE = 'results';

interface CacheRecord {
  hash: string;
  label: string;
  confidence: number;
  configVersion: number;
  /** Insertion order counter, for simple FIFO-ish eviction. */
  seq: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let seqCounter = 0;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'hash' });
        store.createIndex('seq', 'seq');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** Look up many hashes at once; returns hits (current config only) + misses. */
export async function idbGet(
  hashes: string[],
): Promise<{ results: ClassifyResult[]; misses: string[] }> {
  const db = await openDb();
  const store = tx(db, 'readonly');
  const results: ClassifyResult[] = [];
  const misses: string[] = [];
  await Promise.all(
    hashes.map(
      (hash) =>
        new Promise<void>((resolve) => {
          const req = store.get(hash);
          req.onsuccess = () => {
            const rec = req.result as CacheRecord | undefined;
            if (rec && rec.configVersion === CONFIG_VERSION) {
              results.push({
                hash: rec.hash,
                label: rec.label,
                confidence: rec.confidence,
                source: 'cache',
              });
            } else {
              misses.push(hash);
            }
            resolve();
          };
          req.onerror = () => {
            misses.push(hash);
            resolve();
          };
        }),
    ),
  );
  return { results, misses };
}

export async function idbPut(results: ClassifyResult[]): Promise<void> {
  if (results.length === 0) return;
  const db = await openDb();
  const store = tx(db, 'readwrite');
  for (const r of results) {
    const rec: CacheRecord = {
      hash: r.hash,
      label: r.label,
      confidence: r.confidence,
      configVersion: CONFIG_VERSION,
      seq: seqCounter++,
    };
    store.put(rec);
  }
  await new Promise<void>((resolve, reject) => {
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
  });
}

/** Wipe all cached results (used by the options "Clear cache" button). */
export async function idbClear(): Promise<void> {
  const db = await openDb();
  const store = tx(db, 'readwrite');
  store.clear();
  await new Promise<void>((resolve, reject) => {
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
  });
}

/** Evict oldest records (by seq) when over the cap. Best-effort. */
export async function idbEvictIfOver(maxEntries: number): Promise<void> {
  const db = await openDb();
  const store = tx(db, 'readwrite');
  const count = await new Promise<number>((resolve) => {
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(0);
  });
  if (count <= maxEntries) return;
  let toDelete = count - maxEntries;
  await new Promise<void>((resolve) => {
    const idx = store.index('seq');
    const cursorReq = idx.openCursor(); // ascending seq → oldest first
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor && toDelete > 0) {
        cursor.delete();
        toDelete--;
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorReq.onerror = () => resolve();
  });
}
