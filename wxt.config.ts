import { defineConfig } from 'wxt';

// WXT config — Vite/Rollup under the hood. Entrypoints live in src/entrypoints,
// shared logic in src/{shared,content,offscreen}. The `@` alias resolves to src/.
export default defineConfig({
  srcDir: 'src',
  // Select onnxruntime-web's "extern wasm" build so Vite does NOT also bundle a
  // copy of the 13 MB .wasm into assets/. We ship + load it ourselves from ort/
  // (scripts/copy-ort.mjs) via ort.env.wasm.wasmPaths.
  vite: () => ({
    resolve: { conditions: ['onnxruntime-web-use-extern-wasm'] },
  }),
  // Bundled assets (the model label map) — copied to the output root, so
  // labels.json is reachable at chrome.runtime.getURL('models/labels.json').
  publicDir: 'src/public',
  manifest: {
    name: 'Icon Labeler',
    description:
      'Auto-labels unlabeled SVG icons on any page for screen readers — fully on-device, no network calls.',
    // No `scripting`: the content script is statically declared.
    // <all_urls> host permission is required by the goal ("all icons on any page").
    permissions: ['offscreen', 'storage'],
    host_permissions: ['<all_urls>'],
    minimum_chrome_version: '116',
    // `wasm-unsafe-eval` is harmless now and avoids a manifest change when the
    // real onnxruntime-web model lands in the offscreen document.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
