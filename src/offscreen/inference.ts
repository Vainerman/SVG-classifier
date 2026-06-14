/**
 * The classifier seam. The entire mock→ONNX swap happens behind `Classifier`:
 * `MockClassifier` ships now; `OnnxClassifier` (onnxruntime-web) drops in later
 * with the IDENTICAL input/output contract — no message or pipeline change.
 */
import { MOCK_MODE } from '@/shared/config';
import { hashToUint32 } from '@/shared/hash';
import type { ClassifyItem, ClassifyResult } from '@/shared/messages';
import { base64ToFloat32, checksumTensor } from '@/shared/tensor';

export interface Classifier {
  /** Resolve once the model/labels are loaded and the session is warm. */
  ready(): Promise<void>;
  /** Classify a batch. Same input shape the real model will receive. */
  classify(items: ClassifyItem[]): Promise<ClassifyResult[]>;
}

export interface MockOptions {
  /** Decode + checksum each tensor to assert real rasterized data arrived. */
  verifyTensors?: boolean;
}

/**
 * Deterministic placeholder classifier. The label and confidence are derived
 * purely from the SVG hash, so the SAME icon always gets the SAME label across
 * reloads — which makes dedup/cache behavior observably correct during manual
 * testing. The tensor is ignored for the prediction but (optionally) verified.
 */
export class MockClassifier implements Classifier {
  constructor(
    private readonly labels: string[],
    private readonly opts: MockOptions = {},
  ) {}

  async ready(): Promise<void> {
    if (this.labels.length === 0) {
      throw new Error('MockClassifier: labels.json is empty');
    }
  }

  async classify(items: ClassifyItem[]): Promise<ClassifyResult[]> {
    return items.map((item) => {
      if (this.opts.verifyTensors) this.verify(item);
      const seed = hashToUint32(item.hash);
      const index = seed % this.labels.length;
      // 0.50..0.99, deterministic from a different slice of the hash.
      const confidence = 0.5 + ((seed >>> 8) % 50) / 100;
      return {
        hash: item.hash,
        label: this.labels[index],
        confidence,
        source: 'model' as const,
      };
    });
  }

  private verify(item: ClassifyItem): void {
    try {
      const arr = base64ToFloat32(item.tensor.data);
      const { finite, nonZero, length } = checksumTensor(arr);
      if (!finite || nonZero === 0 || length === 0) {
        console.warn(
          `[icon-labeler] mock: suspicious tensor for ${item.hash}`,
          { finite, nonZero, length },
        );
      }
    } catch (err) {
      console.warn(`[icon-labeler] mock: tensor decode failed for ${item.hash}`, err);
    }
  }
}

/**
 * Factory. ORT is dynamically imported only on the real path so it's code-split
 * into the offscreen chunk and never pulled into the unit-test graph.
 */
export async function createClassifier(labels: string[]): Promise<Classifier> {
  if (MOCK_MODE) {
    return new MockClassifier(labels, { verifyTensors: true });
  }
  const { OnnxClassifier } = await import('@/offscreen/onnx');
  return new OnnxClassifier(labels);
}

// ── labels.json parsing ──────────────────────────────────────────────────────
interface LabelEntry {
  index: number;
  name: string;
  display?: string;
}
export interface LabelsFile {
  version: number;
  labels: LabelEntry[];
}

/**
 * Parse the lab's labels.json into a flat string[] indexed by model output
 * column. Names are humanized for screen readers ("arrow_right" → "arrow right").
 */
export function parseLabels(file: LabelsFile): string[] {
  const out: string[] = [];
  for (const entry of file.labels) {
    out[entry.index] = humanize(entry.display || entry.name);
  }
  // Fill any gaps defensively so argmax never lands on undefined.
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = 'unknown';
  return out;
}

function humanize(name: string): string {
  return name.replace(/[_-]+/g, ' ').trim();
}
