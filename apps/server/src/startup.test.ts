import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * O `pnpm server` roda o TypeScript direto no Node (sem bundler). O Vitest resolve imports que o Node
 * não resolve (ex.: sem a extensão `.ts`), então este teste sobe o servidor de verdade e chama a API.
 */
describe("o servidor sobe com o Node puro", () => {
  it("responde /api/health", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aurora-startup-"));
    const port = 34000 + Math.floor(Math.random() * 2000);
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/index.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, AURORA_DB: join(dir, "a.db"), AURORA_PORT: String(port), AURORA_HOST: "127.0.0.1", AURORA_TRUST_CLOUDFLARE: "" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    try {
      let health: { ok?: boolean } | null = null;
      for (let i = 0; i < 60 && !health && child.exitCode === null; i++) {
        health = await fetch(`http://127.0.0.1:${port}/api/health`)
          .then((r) => r.json() as Promise<{ ok?: boolean }>)
          .catch(() => null);
        if (!health) await new Promise((r) => setTimeout(r, 150));
      }
      expect(stderr.slice(0, 400)).toBe("");
      expect(health?.ok).toBe(true);
    } finally {
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
