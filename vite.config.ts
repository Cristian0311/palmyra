import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [
      react(), 
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['palmyra-email-logo.jpg'],
        devOptions: {
          enabled: true
        },
        manifest: {
          id: '/',
          name: 'PALMYRA POS - Gestión empresarial',
          short_name: 'PALMYRA POS',
          description: 'Punto de venta empresarial',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          display_override: ['fullscreen', 'standalone'],
          orientation: 'any',
          background_color: '#ffffff',
          theme_color: '#ffffff',
          icons: [
            {
              src: '/pwa-192.svg',
              sizes: '192x192',
              type: 'image/svg+xml',
              purpose: 'any maskable'
            },
            {
              src: '/pwa-512.svg',
              sizes: '512x512',
              type: 'image/svg+xml',
              purpose: 'any maskable'
            }
          ]
        },
        workbox: {
          maximumFileSizeToCacheInBytes: 5000000,
          // Remove caches from previous generated service workers so an old
          // application shell cannot survive a Render deployment.
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          // Supabase is the source of truth. Never let Workbox cache REST
          // responses or make a reconnect replay a stale API response.
          // Los chunks de las rutas deben quedar precacheados. Excluirlos
          // provoca "Failed to fetch dynamically imported module" cuando el
          // dispositivo pierde conexión antes de abrir una sección.
          globIgnores: [
            '**/vendor-xlsx-*.js',
            '**/vendor-charts-*.js'
          ],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/hmcvujyqloyjdvngpdxz\.supabase\.co\/(rest|auth|storage|functions)\/.*$/i,
              handler: 'NetworkOnly',
              options: { cacheName: 'supabase-network-only' }
            },
            {
              urlPattern: /\/assets\/.*\.js$/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'palmyra-js-runtime-cache-v2',
                expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 30 }
              }
            }
          ]
        }
      })
    ],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('xlsx')) return 'vendor-xlsx';
              if (id.includes('jspdf')) return 'vendor-pdf';
              if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts';
              if (id.includes('lucide-react')) return 'vendor-icons';
              if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom') || id.includes('zustand')) {
                return 'vendor-core';
              }
            }
          }
        }
      },
      chunkSizeWarningLimit: 1200,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true' ? { overlay: false } : false,
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
