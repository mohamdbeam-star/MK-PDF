import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { readFileSync } from 'node:fs';

const version = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();

export default defineConfig({
  base: './', // loaded from file:// (Windows) and the Android web view
  plugins: [preact()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0, chunkSizeWarningLimit: 4000 },
  worker: { format: 'es' },
});
