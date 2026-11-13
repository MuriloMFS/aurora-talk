import { defineConfig } from "vite";

/**
 * Empacota o servidor num arquivo só (`dist/aurora-server.mjs`) para o deploy no Linux:
 * o servidor de produção só precisa do Node 22, sem node_modules nem pnpm.
 */
export default defineConfig({
  build: {
    ssr: "src/index.ts",
    outDir: "dist",
    target: "node22",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      // dependências opcionais do `ws` (aceleração nativa): ele funciona sem elas
      external: ["bufferutil", "utf-8-validate"],
      output: { entryFileNames: "aurora-server.mjs", format: "es", codeSplitting: false },
    },
  },
  ssr: { noExternal: true, target: "node" },
});
