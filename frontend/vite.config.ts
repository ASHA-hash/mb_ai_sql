import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Allow the dev server to serve files from the parent directory.
    // Required so @import "../../assets/dashboard.css" in src/index.css
    // is accessible during `npm run dev` (Vite 5 restricts fs by default).
    fs: {
      allow: [".."],
    },
    proxy: {
      // Proxy all /api requests to FastAPI backend during development
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          charts: ["recharts"],
        },
      },
    },
  },
});
