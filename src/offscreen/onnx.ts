/**
 * Real classifier: onnxruntime-web on the WASM CPU EP. Isolated in its own module
 * so the ORT import is only pulled into the offscreen-document chunk (via the
 * dynamic import in inference.ts) and never into the unit-test graph.
 *
 * WASM (not WebGPU) for v1: the model is tiny (64×64, ~2M params, ~7 MB fp32) so
 * CPU inference is single-digit-to-tens of ms, and WASM runs everywhere with no
 * WebGPU/cross-origin-isolation caveats. numThreads=1 avoids the SharedArrayBuffer
 * (COOP/COEP) requirement that extension pages don't satisfy by default.
 */
import * as ort from 'onnxruntime-web/wasm';
import { CONFIG_VERSION, MODEL_URL_PATH, PREPROCESS } from '@/shared/config';
import type { Classifier } from '@/offscreen/inference';
import type { ClassifyItem, ClassifyResult } from '@/shared/messages';
import { base64ToFloat32 } from '@/shared/tensor';

const C = PREPROCESS.channels;
const H = PREPROCESS.inputSize;
const W = PREPROCESS.inputSize;
const PER = C * H * W;

export class OnnxClassifier implements Classifier {
  private session: ort.InferenceSession | null = null;
  private inputName = 'input';
  private outputName = 'logits';

  constructor(private readonly labels: string[]) {}

  async ready(): Promise<void> {
    if (this.labels.length === 0) throw new Error('OnnxClassifier: empty labels');
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
    ort.env.wasm.numThreads = 1;
    const url = chrome.runtime.getURL(MODEL_URL_PATH);
    this.session = await ort.InferenceSession.create(url, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    this.inputName = this.session.inputNames[0] ?? 'input';
    this.outputName = this.session.outputNames[0] ?? 'logits';
  }

  async classify(items: ClassifyItem[]): Promise<ClassifyResult[]> {
    if (!this.session || items.length === 0) return [];
    const N = items.length;
    const data = new Float32Array(N * PER);
    for (let i = 0; i < N; i++) {
      const t = items[i].tensor;
      if (t.configVersion !== CONFIG_VERSION) continue; // leaves zeros → low-conf → abstain
      data.set(base64ToFloat32(t.data), i * PER);
    }
    const input = new ort.Tensor('float32', data, [N, C, H, W]);
    const outputs = await this.session.run({ [this.inputName]: input });
    const logits = outputs[this.outputName].data as Float32Array;
    const numClasses = this.labels.length;

    return items.map((item, i) => {
      const { index, prob } = softmaxTop1(logits, i * numClasses, numClasses);
      return {
        hash: item.hash,
        label: this.labels[index] ?? 'unknown',
        confidence: prob,
        source: 'model' as const,
      };
    });
  }
}

/** Argmax + its softmax probability over logits[off .. off+n). */
function softmaxTop1(logits: Float32Array, off: number, n: number): { index: number; prob: number } {
  let max = -Infinity;
  let index = 0;
  for (let j = 0; j < n; j++) {
    const v = logits[off + j];
    if (v > max) {
      max = v;
      index = j;
    }
  }
  let sum = 0;
  for (let j = 0; j < n; j++) sum += Math.exp(logits[off + j] - max);
  // softmax(max) = exp(max-max)/sum = 1/sum
  return { index, prob: sum > 0 ? 1 / sum : 0 };
}
