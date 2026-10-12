import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist-admin", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("/lucide-react/")) return "admin-icons";
          if (id.includes("/motion/")) return "admin-motion";
          if (id.includes("/@supabase/")) return "admin-supabase";
          if (id.includes("/react-dom/") || id.includes("/scheduler/")) return "admin-react-dom";
          if (id.includes("/react/")) return "admin-react";
        },
      },
    },
  },
  server: {
    port: 4174,
    strictPort: true,
  },
});
