import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/* Многостраничная статика: каждая HTML-страница — отдельная точка входа.
   base './' обязателен: сайт живёт в подпапке /relik/ на GitHub Pages. */
const rootPages = fs.readdirSync('.').filter((f) => f.endsWith('.html'));
const toolPages = fs.existsSync('tools')
  ? fs.readdirSync('tools').filter((f) => f.endsWith('.html')).map((f) => `tools/${f}`)
  : [];

const input = Object.fromEntries(
  [...rootPages, ...toolPages].map((p) => [p.replace(/\.html$/, '').replace(/[\\/]/g, '_'), p]),
);

export default defineConfig({
  base: './',
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 2048,
    cssCodeSplit: true,
    sourcemap: false,
    rollupOptions: {
      input,
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 8096,
    strictPort: false,
  },
  /* Вендоры — обычные ES-модули, их не надо трогать. */
  optimizeDeps: { include: [] },
});
