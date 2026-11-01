import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { integrationsPlugin, loadEnvironmentConnections } from "./server/integrations.mjs";

await loadEnvironmentConnections();

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), integrationsPlugin()],
});
