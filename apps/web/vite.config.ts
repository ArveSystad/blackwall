import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev only: the blackwall server runs separately (`--dev`) and Vite proxies API and WebSocket
// traffic to it. `changeOrigin` rewrites Host to the server's, which passes its Host check.
const serverPort = Number(process.env.BLACKWALL_PORT ?? 4711);
const webPort = Number(process.env.BLACKWALL_WEB_PORT ?? 5173);
const serverOrigin = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  plugins: [react()],
  // Resolve workspace packages to their TypeScript sources (see package "source" exports).
  resolve: { conditions: ["source"] },
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
