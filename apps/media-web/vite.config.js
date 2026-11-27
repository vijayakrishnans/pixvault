import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The Pixvault media app (PV-6), built with Vite. Upstream provenance is in the port inventory.
export default defineConfig({
  plugins: [vue()],
  // vue-i18n feature flags. JIT compilation turns messages into an AST interpreted at runtime instead of
  // generated code run with `new Function`, so the app works under `script-src 'self'` (PV-8).
  define: {
    __INTLIFY_JIT_COMPILATION__: true,
    __INTLIFY_DROP_MESSAGE_COMPILER__: false,
    __VUE_I18N_FULL_INSTALL__: true,
    __VUE_I18N_LEGACY_API__: true,
    __INTLIFY_PROD_DEVTOOLS__: false,
  },
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
