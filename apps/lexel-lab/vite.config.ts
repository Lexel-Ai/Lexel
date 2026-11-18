import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import copy from 'rollup-plugin-copy';
import { defineConfig, type PluginOption } from 'vite';

// Resolve sibling deps (virtual-dom, colorjs.io) alongside pnpm's lint-framework
// store directory so aliasing lint-framework to its FontAwesome-free TS sources works.
const lintFrameworkDepsDir = path.dirname(
  fs.realpathSync(path.resolve(import.meta.dirname, 'node_modules/lint-framework')),
);

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
      '@': path.resolve(import.meta.dirname, 'src'),
      'lint-framework': path.resolve(import.meta.dirname, 'config/lintFramework.ts'),
      'virtual-dom': path.resolve(lintFrameworkDepsDir, 'virtual-dom'),
      'colorjs.io': path.resolve(lintFrameworkDepsDir, 'colorjs.io'),
      'harper.js': path.resolve(import.meta.dirname, 'node_modules/harper.js'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
