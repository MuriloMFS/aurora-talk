import { defineConfig } from "vite";

// Site público (página de download). Servido pelo próprio servidor do Aurora (apps/server/src/site.ts),
// que repassa /api para a API. Em desenvolvimento, o Vite encaminha /api e /download para :3000.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3000",
      "/download": "http://localhost:3000",
    },
  },
  build: { target: "es2020" },
});
