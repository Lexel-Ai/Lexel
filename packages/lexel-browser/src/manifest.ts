import { defineManifest } from '@crxjs/vite-plugin';
import packageData from '../package.json' with { type: 'json' };

const isDev = process.env.NODE_ENV === 'development';

export function makeExtensionCSP(dev: boolean): string {
  const scriptSrc = ["'self'", "'wasm-unsafe-eval'"];
  const objectSrc = ["'self'"];
  // Local-only privacy invariant: only loopback 127.0.0.1 / localhost endpoints allowed.
  const connectSrc = ["'self'", 'http://127.0.0.1:*', 'http://localhost:*'];
  const styleSrc = ["'self'", "'unsafe-inline'"];
  const fontSrc = ["'self'", 'data:'];

  if (dev) {
    connectSrc.push('ws://localhost:5173', 'ws://127.0.0.1:*');
  }

  return [
    `script-src ${scriptSrc.join(' ')}`,
    `object-src ${objectSrc.join(' ')}`,
    `connect-src ${connectSrc.join(' ')}`,
    `style-src ${styleSrc.join(' ')}`,
    `font-src ${fontSrc.join(' ')}`,
  ].join('; ');
}

export default defineManifest({
  name: `Lexel - Local Grammar & Anti-Slop AI${isDev ? ' (Dev)' : ''}`,
  description: 'Local-first grammar checker powered by Harper and privacy-first anti-slop AI.',
  version: packageData.version,
  manifest_version: 3,
  action: {
    default_popup: 'popup.html',
  },
  side_panel: {
    default_path: 'sidepanel.html',
  },
  options_page: 'options.html',
  browser_specific_settings: {
    gecko: {
      id: 'lexel@lexel.local',
      strict_min_version: '146.0',
    },
  },
  background: {
    service_worker: 'src/background/index.ts',
    scripts: ['src/background/index.ts'],
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://docs.google.com/document/*'],
      all_frames: false,
      js: ['src/contentScript/googleDocsBootstrap.js'],
      run_at: 'document_start',
      world: 'MAIN',
    },
    {
      matches: ['<all_urls>'],
      all_frames: true,
      match_about_blank: true,
      // @ts-expect-error Valid Chromium MV3 manifest key not yet in @crxjs types.
      match_origin_as_fallback: true,
      js: ['src/contentScript/index.ts'],
      run_at: 'document_idle',
    },
  ],
  web_accessible_resources: [
    {
      matches: ['<all_urls>'],
      resources: [
        'wasm/harper_wasm_bg.wasm',
        'google-docs-bridge.js',
        'google-docs-protocol.js',
        'google-docs-bridge-request-handler.js',
      ],
    },
  ],
  permissions: ['storage', 'tabs', 'sidePanel', 'activeTab', 'nativeMessaging'],
  host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
  content_security_policy: {
    extension_pages: makeExtensionCSP(isDev),
  },
});
