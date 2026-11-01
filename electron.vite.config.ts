import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    // Keep small fonts as files so `default-src 'self'` in the page's CSP loads them without `data:`.
    build: { assetsInlineLimit: 0 },
    plugins: [react(), tailwind()],
  },
});
