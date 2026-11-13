// Telas reais do Aurora para o site de download (apps/site/screens): o app aberto e a janela de
// transmissão de tela, em WebP 2x, nos temas escuro e claro.
// Monta uma conversa de exemplo num servidor LOCAL com banco vazio e fotografa a interface num
// Microsoft Edge sem janela (áudio mudo). Nada vai para a internet.
//
// Antes, em outros terminais:  pnpm dev:web   (interface em :1420)   e   pnpm voice   (LiveKit em :7880)
// A porta 3000 precisa estar livre: o roteiro sobe o próprio servidor.
// Uso: node scripts/site-screens.mjs [pasta-de-saída]   (padrão: apps/site/screens)
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => existsSync(p));
if (!EDGE) throw new Error("Microsoft Edge não encontrado.");
const out = resolve(process.argv[2] ?? join(ROOT, "apps/site/screens"));
mkdirSync(out, { recursive: true });
const SERVER = "http://localhost:3000";
const UI = "http://localhost:1420/";
const port = 9337;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, token, body, method = "POST") => {
  const res = await fetch(`${SERVER}${path}`, { method, headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};
const tag = process.env.SHOT_TAG ?? "";
const register = (user, displayName) => api("/api/auth/register", null, { username: `${user}${tag}`, displayName, password: randomBytes(12).toString("base64url") });

// ---------- servidor local só para as fotos (banco vazio) ----------
// A cor do avatar sai do ID da conta (apps/desktop/src/messages.ts): repete com banco novo até
// as cinco pessoas terem cores diferentes, para a foto não ficar monótona.
const avatarIndex = (id) => {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 8;
};
let server;
let people;
for (let attempt = 1; attempt <= 12 && !people; attempt++) {
  const db = join(mkdtempSync(join(tmpdir(), "aurora-fotos-db-")), "fotos.db");
  server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/index.ts"], {
    cwd: join(ROOT, "apps/server"),
    env: { ...process.env, AURORA_DB: db, AURORA_PORT: "3000", AURORA_HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${SERVER}/api/health`)).ok) break;
    } catch {}
    await wait(250);
  }
  const accounts = [await register("lia", "Lia"), await register("davi", "Davi"), await register("luisa", "Luisa"), await register("caio", "Caio"), await register("rafa", "Rafa")];
  const colors = new Set(accounts.map((a) => avatarIndex(a.user.id)));
  if (colors.size === accounts.length) {
    people = accounts;
    console.log(`cores diferentes na tentativa ${attempt}`);
  } else {
    server.kill();
    await wait(800);
  }
}
if (!people) throw new Error("não consegui cores diferentes para os avatares");
process.on("exit", () => server?.kill());

// ---------- conversa de exemplo ----------
const [lia, davi, luisa, caio, rafa] = people;
const guild = await api("/api/guilds", lia.token, { name: "Turma do sábado" });
const invite = await api(`/api/guilds/${guild.id}/invites`, lia.token);
for (const u of [davi, luisa, caio, rafa]) await api(`/api/invites/${invite.code}`, u.token);
await api(`/api/guilds/${guild.id}/channels`, lia.token, { name: "jogos", type: "text" });
await api(`/api/guilds/${guild.id}/channels`, lia.token, { name: "clipes", type: "text" });
await api(`/api/guilds/${guild.id}/channels`, lia.token, { name: "Lobby", type: "voice" });
const geral = guild.channels.find((c) => c.type === "text");
const sala = guild.channels.find((c) => c.type === "voice");
const say = (u, content, replyToId) => api(`/api/channels/${geral.id}/messages`, u.token, { content, nonce: randomBytes(6).toString("hex"), ...(replyToId && { replyToId }) });
const react = (u, m, emoji) => api(`/api/channels/${geral.id}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`, u.token, undefined, "PUT");

const m1 = await say(luisa, "Bora jogar hoje às 21h? Quem topa?");
await say(davi, "Topo! Vou chamar o pessoal do outro grupo também", m1.id);
await say(caio, "Chego 21h15, tô saindo do trabalho agora");
await say(rafa, "Separei a config que a gente combinou ontem:\n```\nsensibilidade = 0.42\nfov = 103\n```");
const m5 = await say(lia, "Fechou! Já deixei a sala de voz aberta. **Quem chegar primeiro escolhe o mapa.**");
await say(rafa, `<@${lia.user.id}> então pode deixar que eu escolho`, m5.id);
const m7 = await say(luisa, "||vou ganhar de novo||");
for (const u of [davi, caio, lia]) await react(u, m1, "🔥");
await react(rafa, m1, "👍");
for (const u of [luisa, davi]) await react(u, m5, "✅");
for (const u of [davi, rafa, caio]) await react(u, m7, "😂");

// ---------- os outros ficam online (gateway) e alguns entram na voz ----------
function gatewayAs(user, onReady) {
  const ws = new WebSocket(`${SERVER.replace("http", "ws")}/gateway`);
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data);
    if (frame.op === "hello") {
      ws.send(JSON.stringify({ op: "identify", token: user.token, v: 2 }));
      setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ op: "heartbeat" })), frame.heartbeatIntervalMs ?? 30000);
    }
    if (frame.op === "ready") onReady?.(ws);
  });
  return ws;
}
const send = (ws, frame) => ws.send(JSON.stringify(frame));
const sockets = [
  gatewayAs(davi, (ws) => send(ws, { op: "voice_join", channelId: sala.id, muted: false, deafened: false })),
  gatewayAs(luisa, (ws) => {
    send(ws, { op: "voice_join", channelId: sala.id, muted: false, deafened: false });
    setTimeout(() => send(ws, { op: "voice_state", muted: false, deafened: false, streaming: true }), 300);
  }),
  gatewayAs(rafa, (ws) => send(ws, { op: "voice_join", channelId: sala.id, muted: true, deafened: false })),
  gatewayAs(caio),
];
await wait(1500);
const caioWs = sockets[3];
const typing = setInterval(() => caioWs.readyState === 1 && send(caioWs, { op: "typing", channelId: geral.id }), 2000);

// ---------- Edge headless ----------
const profile = mkdtempSync(join(tmpdir(), "aurora-site-shots-"));
const edge = spawn(EDGE, [
  "--headless=new", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

let page;
for (let i = 0; i < 40 && !page; i++) {
  try {
    page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
  } catch {}
  if (!page) await wait(300);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
const rectOf = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const shot = async (name, clip) => {
  const params = { format: "webp", quality: 86, captureBeyondViewport: false, ...(clip && { clip: { ...clip, scale: 1 } }) };
  const { data } = await cdp("Page.captureScreenshot", params);
  writeFileSync(join(out, `${name}.webp`), Buffer.from(data, "base64"));
  console.log("tela", name, clip ? `${Math.round(clip.width)}x${Math.round(clip.height)}` : "1280x800");
};
const clickLabel = (start) => evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "").startsWith(${JSON.stringify(start)})); if (!b) return false; b.click(); return true; })()`);
const key = (k, code, vk, modifiers = 0) => cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });

try {
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 840, deviceScaleFactor: 2, mobile: false });
  const session = JSON.stringify({ serverUrl: SERVER, token: lia.token, user: lia.user });
  await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("aurora.session", ${JSON.stringify(session)}); localStorage.setItem("aurora.server", "${SERVER}"); if (!sessionStorage.getItem("seeded")) { localStorage.removeItem("aurora.settings"); sessionStorage.setItem("seeded", "1"); } } catch {}`,
  });

  for (const theme of ["dark", "light"]) {
    await cdp("Page.navigate", { url: UI });
    await wait(1500);
    await evaluate(`localStorage.setItem("aurora.theme", "${theme}"); location.reload(); true`);
    await wait(4000);
    // Lia entra na voz pela interface (LiveKit local)
    await clickLabel("Sala de voz");
    for (let i = 0; i < 30 && !(await evaluate(`document.querySelector(".voice-panel__status")?.textContent === "Voz conectada"`)); i++) await wait(300);
    await wait(2500);
    // tira o foco de qualquer botão (sem anel de foco na foto)
    await evaluate(`document.activeElement?.blur(); document.querySelector(".messages")?.scrollTo({ top: 1e6 }); true`);
    await wait(400);
    await shot(`app-${theme}`);
    // diálogo de transmissão de tela
    await clickLabel("Compartilhar tela");
    await wait(700);
    await evaluate(`document.activeElement?.blur(); true`);
    const modal = await rectOf(".modal");
    if (modal) await shot(`share-${theme}`, { x: modal.x - 24, y: modal.y - 24, width: modal.width + 48, height: modal.height + 48 });
    await key("Escape", "Escape", 27);
    await wait(400);

    await clickLabel("Sair da voz");
    await wait(800);
  }
} finally {
  clearInterval(typing);
  for (const s of sockets) s.close();
  ws.close();
  edge.kill();
  await wait(1500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
// imagem de compartilhamento (og:image) com endereço fixo
if (out === resolve(ROOT, "apps/site/screens")) copyFileSync(join(out, "app-dark.webp"), join(ROOT, "apps/site/public/og.webp"));
console.log(`Telas salvas em ${out}. Depois: pnpm deploy:server`);
process.exit(0);
