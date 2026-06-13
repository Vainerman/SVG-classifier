/**
 * Offscreen document script. Loads the label map, builds the (mock) classifier,
 * and answers OFFSCREEN_CLASSIFY requests from the service worker.
 *
 * The browser can tear this document down at any time; the service worker
 * recreates it on demand, so this script just (re)initializes on load.
 */
import { LABELS_URL_PATH } from '@/shared/config';
import { createClassifier, type Classifier } from '@/offscreen/inference';
import type {
  OffscreenClassifyResponse,
  OffscreenRequest,
} from '@/shared/messages';

interface LabelsFile {
  version: number;
  labels: string[];
}

let classifierPromise: Promise<Classifier> | null = null;

function getClassifier(): Promise<Classifier> {
  if (!classifierPromise) classifierPromise = init();
  return classifierPromise;
}

async function init(): Promise<Classifier> {
  const url = chrome.runtime.getURL(LABELS_URL_PATH);
  const res = await fetch(url);
  const labelsFile = (await res.json()) as LabelsFile;
  const classifier = createClassifier(labelsFile.labels);
  await classifier.ready();
  return classifier;
}

chrome.runtime.onMessage.addListener(
  (msg: OffscreenRequest, _sender, sendResponse: (r: OffscreenClassifyResponse) => void) => {
    if (msg?.target !== 'offscreen' || msg.type !== 'OFFSCREEN_CLASSIFY') return;
    getClassifier()
      .then((c) => c.classify(msg.items))
      .then((results) => sendResponse({ results }))
      .catch((err) => {
        console.warn('[icon-labeler] offscreen classify error', err);
        sendResponse({ results: [] });
      });
    return true; // async response
  },
);

// Warm the classifier as soon as the document loads.
void getClassifier().then(() => {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY', target: 'background' }).catch(() => {
    /* no listener yet — harmless */
  });
});
