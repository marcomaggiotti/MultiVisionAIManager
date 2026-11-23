import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The version shown in the top bar: package.json's, the build time, and the git commit
// when the repository is there (not inside the Docker build, which only has manager/web).
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
})();

// In development the manager API runs on :8080 (uvicorn); Vite forwards /api to it.
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __GIT_COMMIT__: JSON.stringify(process.env.GIT_COMMIT ?? commit),
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.MANAGER_API ?? "http://localhost:8080", changeOrigin: true, ws: true } },
  },
});
