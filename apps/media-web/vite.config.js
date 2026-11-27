import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The Pixvault media app (PV-6), built with Vite. Upstream provenance is in the port inventory.
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        // Vendor code changes rarely; keep it in its own long-cached chunk.
        manualChunks: (id) => (id.includes("node_modules/element-plus") ? "element-plus" : id.includes("node_modules") ? "vendor" : undefined),
      },
    },
  },
});
