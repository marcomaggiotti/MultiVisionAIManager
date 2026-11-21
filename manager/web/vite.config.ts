import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the manager API runs on :8080 (uvicorn); Vite forwards /api to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.MANAGER_API ?? "http://localhost:8080", changeOrigin: true, ws: true } },
  },
});
