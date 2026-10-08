import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev only: the blackwall server runs separately (`--dev`) and Vite proxies API and WebSocket
// traffic to it. `changeOrigin` rewrites Host to the server's, which passes its Host check.
const serverPort = Number(process.env.BLACKWALL_PORT ?? 4711);
const webPort = Number(process.env.BLACKWALL_WEB_PORT ?? 5173);
const serverOrigin = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Resolve workspace packages to their TypeScript sources (see package "source" exports).
  resolve: {
    conditions: ["source"],
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Served from localhost, so one bundle is fine.
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": { target: serverOrigin, changeOrigin: true },
      "/ws": { target: serverOrigin, changeOrigin: true, ws: true },
    },
  },
});
