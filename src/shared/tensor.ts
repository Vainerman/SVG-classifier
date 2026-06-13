/**
 * Tensor wire-format helpers.
 *
 * chrome.runtime messaging is JSON-serialized, so Float32Array/ArrayBuffer do
 * not survive the trip. We base64-encode the little-endian Float32 bytes. The
 * mock classifier ignores tensor VALUES (it keys off the hash) but still decodes
 * + checksums them in debug mode, so the real rasterization path is validated
 * end-to-end before the ONNX model exists.
 */

export function float32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = '';
  const CHUNK = 0x8000; // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export interface TensorChecksum {
  /** All values finite (no NaN/Infinity from a bad raster). */
  finite: boolean;
  /** Count of non-zero values — a fully-zero tensor means rasterization failed. */
  nonZero: number;
  length: number;
}

export function checksumTensor(arr: Float32Array): TensorChecksum {
  let finite = true;
  let nonZero = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v)) finite = false;
    if (v !== 0) nonZero++;
  }
  return { finite, nonZero, length: arr.length };
}
