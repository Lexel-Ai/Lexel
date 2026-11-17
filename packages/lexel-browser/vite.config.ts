import { crx } from '@crxjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import copy from 'rollup-plugin-copy';
import { defineConfig, loadEnv, type PluginOption } from 'vite';
import manifest from './src/manifest';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const browser = env.TARGET_BROWSER ?? 'chrome';

  if (browser !== 'chrome' && browser !== 'firefox') {
    throw new Error(`Unsupported TARGET_BROWSER: ${browser}`);
  }

  return {
    build: {
      outDir: 'dist',
      minify: mode === 'production',
      rollupOptions: {
        input: {
          sidepanel: path.resolve(__dirname, 'sidepanel.html'),
        },
        output: {
          chunkFileNames: 'assets/chunk-[hash].js',
        },
      },
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
      crx({ manifest, browser }) as unknown as PluginOption,
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
  };
});
