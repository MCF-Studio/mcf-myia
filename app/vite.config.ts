import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// Tauri attend le serveur de dev sur un port fixe ; rien n'écoute hors 127.0.0.1.
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1", watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 900 },
});
