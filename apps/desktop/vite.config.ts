import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Configuração recomendada pelo Tauri 2 para Vite (porta fixa, sem limpar o terminal,
// variáveis TAURI_ENV_* expostas, sem observar src-tauri).
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  // livekit-client só é importado sob demanda (ao entrar na voz); pré-otimizar evita que o
  // Vite recarregue a página no meio da 1ª conexão de voz em modo de desenvolvimento.
  optimizeDeps: { include: ["livekit-client"] },
  build: {
    // WebView2 no Windows é Chromium; demais plataformas usam WebKit.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
