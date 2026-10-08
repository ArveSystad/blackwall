import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Resolve workspace packages to their TypeScript sources (see package "source" exports).
  resolve: { conditions: ["source"] },
});
