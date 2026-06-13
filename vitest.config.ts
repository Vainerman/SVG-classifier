import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Standalone Vitest config (does not load the WXT plugin). All unit-tested logic
// lives in plain src/ modules that import via the `@` alias → src/.
export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
