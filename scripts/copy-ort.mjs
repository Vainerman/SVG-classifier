/**
 * Copy the onnxruntime-web WASM binary into src/public/ort/ so WXT bundles it
 * (dev + build) and it's reachable at chrome.runtime.getURL('ort/...').
 *
 * The .wasm is ~13 MB and fully reproducible from npm, so it is gitignored and
 * re-copied here on every `npm install` (postinstall) rather than committed.
 * The trained model (public/models/*.onnx) IS committed — it's not reproducible
 * without the lab.
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = resolve(root, 'node_modules/onnxruntime-web/dist');
const DEST_DIR = resolve(root, 'src/public/ort');

// The extern-wasm ORT build (selected via the Vite resolve condition in
// wxt.config.ts) loads BOTH the Emscripten glue (.mjs) and the binary (.wasm)
// from wasmPaths at runtime. Shipping only the .wasm fails at session create.
const FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

mkdirSync(DEST_DIR, { recursive: true });
let copied = 0;
for (const f of FILES) {
  const src = resolve(SRC_DIR, f);
  if (!existsSync(src)) {
    console.warn('[copy-ort] missing (is onnxruntime-web installed?):', src);
    continue;
  }
  copyFileSync(src, resolve(DEST_DIR, f));
  copied++;
}
console.log(`[copy-ort] copied ${copied}/${FILES.length} ORT runtime file(s) → ${DEST_DIR}`);
