import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import copy from 'rollup-plugin-copy';
import { defineConfig, type PluginOption } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
  },
  plugins: [
    copy({
      hook: 'buildStart',
      targets: [
        {
          src: '../../vendor/harper/packages/harper.js/dist/harper_wasm_bg.wasm',
          dest: './public/wasm',
        },
      ],
    }) as unknown as PluginOption,
    tailwindcss(),
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
