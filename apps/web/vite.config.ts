import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.SUBWAVE_API_PROXY ?? "http://127.0.0.1:8788";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
