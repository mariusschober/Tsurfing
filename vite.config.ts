import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  server: { port: 3000, host: '0.0.0.0' },
  build: {
    outDir: 'dist/client',
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@hello-pangea')) return 'drag-and-drop';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react';
          return 'vendor';
        }
      }
    }
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icons/icon.svg', 'icons/maskable.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Tsurfing',
        short_name: 'Tsurfing',
        description: 'Plan deliberately, then execute exactly one task.',
        theme_color: '#4F46E5',
        background_color: '#F7F8FA',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icons/maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }
        ],
        shortcuts: [
          { name: 'Current task', short_name: 'Current', url: '/?view=current', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Add task', short_name: 'Add', url: '/?capture=task', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] }
        ],
        share_target: {
          action: '/?capture=share',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' }
        }
      },
      workbox: {
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/ice\d+\.somafm\.com\//,
            handler: 'NetworkOnly'
          }
        ]
      },
      // A development service worker can keep serving an obsolete app after the
      // local server restarts. Production builds still generate the full PWA.
      devOptions: { enabled: false }
    })
  ],
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/tests/e2e/**',
      '**/e2e/**',
      '**/chrome-extension/**',
      '**/.idea/**',
      '**/.git/**',
      '**/android/**',
      '**/android-native/**'
    ]
  }
});
