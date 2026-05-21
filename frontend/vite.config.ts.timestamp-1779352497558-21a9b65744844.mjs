// vite.config.ts
import { defineConfig } from "file:///sessions/cool-wizardly-faraday/mnt/SMART%20ERP%20INTEGRATIONS%20FROM%20GOOGLE%20SHEETS/frontend/node_modules/vite/dist/node/index.js";
import react from "file:///sessions/cool-wizardly-faraday/mnt/SMART%20ERP%20INTEGRATIONS%20FROM%20GOOGLE%20SHEETS/frontend/node_modules/@vitejs/plugin-react/dist/index.js";
var vite_config_default = defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Allow the dev server to serve files from the parent directory.
    // Required so @import "../../assets/dashboard.css" in src/index.css
    // is accessible during `npm run dev` (Vite 5 restricts fs by default).
    fs: {
      allow: [".."]
    },
    proxy: {
      // Proxy all /api requests to FastAPI backend during development
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        secure: false
      }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          charts: ["recharts"]
        }
      }
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvc2Vzc2lvbnMvY29vbC13aXphcmRseS1mYXJhZGF5L21udC9TTUFSVCBFUlAgSU5URUdSQVRJT05TIEZST00gR09PR0xFIFNIRUVUUy9mcm9udGVuZFwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL3Nlc3Npb25zL2Nvb2wtd2l6YXJkbHktZmFyYWRheS9tbnQvU01BUlQgRVJQIElOVEVHUkFUSU9OUyBGUk9NIEdPT0dMRSBTSEVFVFMvZnJvbnRlbmQvdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL3Nlc3Npb25zL2Nvb2wtd2l6YXJkbHktZmFyYWRheS9tbnQvU01BUlQlMjBFUlAlMjBJTlRFR1JBVElPTlMlMjBGUk9NJTIwR09PR0xFJTIwU0hFRVRTL2Zyb250ZW5kL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSBcInZpdGVcIjtcbmltcG9ydCByZWFjdCBmcm9tIFwiQHZpdGVqcy9wbHVnaW4tcmVhY3RcIjtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgcGx1Z2luczogW3JlYWN0KCldLFxuICBzZXJ2ZXI6IHtcbiAgICBwb3J0OiA1MTczLFxuICAgIC8vIEFsbG93IHRoZSBkZXYgc2VydmVyIHRvIHNlcnZlIGZpbGVzIGZyb20gdGhlIHBhcmVudCBkaXJlY3RvcnkuXG4gICAgLy8gUmVxdWlyZWQgc28gQGltcG9ydCBcIi4uLy4uL2Fzc2V0cy9kYXNoYm9hcmQuY3NzXCIgaW4gc3JjL2luZGV4LmNzc1xuICAgIC8vIGlzIGFjY2Vzc2libGUgZHVyaW5nIGBucG0gcnVuIGRldmAgKFZpdGUgNSByZXN0cmljdHMgZnMgYnkgZGVmYXVsdCkuXG4gICAgZnM6IHtcbiAgICAgIGFsbG93OiBbXCIuLlwiXSxcbiAgICB9LFxuICAgIHByb3h5OiB7XG4gICAgICAvLyBQcm94eSBhbGwgL2FwaSByZXF1ZXN0cyB0byBGYXN0QVBJIGJhY2tlbmQgZHVyaW5nIGRldmVsb3BtZW50XG4gICAgICBcIi9hcGlcIjoge1xuICAgICAgICB0YXJnZXQ6IFwiaHR0cDovL2xvY2FsaG9zdDo4MDAwXCIsXG4gICAgICAgIGNoYW5nZU9yaWdpbjogdHJ1ZSxcbiAgICAgICAgc2VjdXJlOiBmYWxzZSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcbiAgYnVpbGQ6IHtcbiAgICBvdXREaXI6IFwiZGlzdFwiLFxuICAgIHNvdXJjZW1hcDogZmFsc2UsXG4gICAgcm9sbHVwT3B0aW9uczoge1xuICAgICAgb3V0cHV0OiB7XG4gICAgICAgIG1hbnVhbENodW5rczoge1xuICAgICAgICAgIHZlbmRvcjogW1wicmVhY3RcIiwgXCJyZWFjdC1kb21cIiwgXCJyZWFjdC1yb3V0ZXItZG9tXCJdLFxuICAgICAgICAgIGNoYXJ0czogW1wicmVjaGFydHNcIl0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0sXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBOGIsU0FBUyxvQkFBb0I7QUFDM2QsT0FBTyxXQUFXO0FBRWxCLElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVMsQ0FBQyxNQUFNLENBQUM7QUFBQSxFQUNqQixRQUFRO0FBQUEsSUFDTixNQUFNO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFJTixJQUFJO0FBQUEsTUFDRixPQUFPLENBQUMsSUFBSTtBQUFBLElBQ2Q7QUFBQSxJQUNBLE9BQU87QUFBQTtBQUFBLE1BRUwsUUFBUTtBQUFBLFFBQ04sUUFBUTtBQUFBLFFBQ1IsY0FBYztBQUFBLFFBQ2QsUUFBUTtBQUFBLE1BQ1Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0EsT0FBTztBQUFBLElBQ0wsUUFBUTtBQUFBLElBQ1IsV0FBVztBQUFBLElBQ1gsZUFBZTtBQUFBLE1BQ2IsUUFBUTtBQUFBLFFBQ04sY0FBYztBQUFBLFVBQ1osUUFBUSxDQUFDLFNBQVMsYUFBYSxrQkFBa0I7QUFBQSxVQUNqRCxRQUFRLENBQUMsVUFBVTtBQUFBLFFBQ3JCO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
