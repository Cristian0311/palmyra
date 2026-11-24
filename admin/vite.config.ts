import { fileURLToPath, URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Cada compilación del panel recibe un identificador propio. La consola lo
// compara con /version.json del servidor para avisar de una actualización
// publicada sin depender del service worker.
const BUILD_ID = Date.now().toString(36);
const BUILT_AT = new Date().toISOString();
const OUT_DIR = fileURLToPath(new URL("../dist-admin", import.meta.url));
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../public", import.meta.url)),
  define: {
    __ADMIN_BUILD__: JSON.stringify(BUILD_ID),
    __ADMIN_BUILT_AT__: JSON.stringify(BUILT_AT),
    __ADMIN_VERSION__: JSON.stringify(PACKAGE_VERSION),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["favicon.ico", "icon.png", "pwa-192.png", "pwa-512.png", "pwa-maskable-512.png", "apple-touch-icon.png"],
      devOptions: { enabled: false },
      manifest: {
        id: "/",
        name: "PALMYRA Admin — Control Center",
        short_name: "PALMYRA Admin",
        description: "Consola administrativa de PALMYRA: empresas, planes, soporte y auditoría.",
        lang: "es",
        dir: "ltr",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#120a22",
        theme_color: "#241143",
        icons: [
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff,woff2}"],
        cleanupOutdatedCaches: true,
      },
    }),
    {
      name: "palmyra-admin-version-json",
      closeBundle() {
        try {
          fs.mkdirSync(OUT_DIR, { recursive: true });
          fs.writeFileSync(
            path.join(OUT_DIR, "version.json"),
            JSON.stringify({ build: BUILD_ID, builtAt: BUILT_AT })
          );
        } catch (error) {
          console.error("[PALMYRA ADMIN] No se pudo escribir version.json:", error);
        }
      },
    },
  ],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 4174,
    strictPort: true,
  },
});
