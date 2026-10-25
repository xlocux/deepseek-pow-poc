"use strict";

// Automatic capture for the DeepSeek POC: opens a real browser, lets you log in, then reads your
// `userToken` from localStorage over CDP and (opportunistically) refreshes the PoW wasm by reading
// the current chunk URL from the live page (which bypasses the bot-protected HTML).
//
//   node capture.js
//
// Output: writes the token to `.ds_token` (git-ignored) and prints it; updates `sha3_wasm_bg.wasm`.
// Needs a local Chrome/Edge/Brave. Uses a persistent profile (`.ds_profile/`) so you log in once.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const PROFILE = path.join(__dirname, ".ds_profile");
const TOKEN_FILE = path.join(__dirname, ".ds_token");
const WASM_OUT = path.join(__dirname, "sha3_wasm_bg.wasm");
const PORT = 9470 + Math.floor(Math.random() * 300);
const TIMEOUT_MS = 5 * 60 * 1000;

function findBrowser() {
  const pf = process.env["ProgramFiles"] || "C:/Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData/Local");
  const win = [
    path.join(pf, "Google/Chrome/Application/chrome.exe"),
    path.join(pf86, "Google/Chrome/Application/chrome.exe"),
    path.join(local, "Google/Chrome/Application/chrome.exe"),
    path.join(pf86, "Microsoft/Edge/Application/msedge.exe"),
    path.join(pf, "Microsoft/Edge/Application/msedge.exe"),
    path.join(pf, "BraveSoftware/Brave-Browser/Application/brave.exe")
  ];
  const nix = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/brave-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return (process.platform === "win32" ? win : nix).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdpReady(port, left) {
  return new Promise((resolve, reject) => {
    const tryOnce = (n) => http.get({ host: "127.0.0.1", port, path: "/json/version" }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(JSON.parse(b)));
    }).on("error", (e) => (n <= 0 ? reject(e) : setTimeout(() => tryOnce(n - 1), 300)));
    tryOnce(left);
  });
}

function makeClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  const ready = new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  return { ws, ready, send: (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); }) };
}

async function evaluate(client, expression) {
  const r = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
}

// --- Robust token extraction ------------------------------------------------
// DeepSeek has stored the token under different shapes over time: a plain string in
// localStorage.userToken, a JSON wrapper like {"value":"…"} (redux-persist), or inside another key.
// We dump all of localStorage (+ cookies) and match it broadly instead of one fixed key.
const looksLikeJwt = (s) => /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s);
const firstJwt = (s) => (typeof s === "string" ? (s.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/) || [""])[0] : "");

function tokenFromValue(value, keyedAsToken) {
  if (typeof value !== "string" || !value) return "";
  const s = value.trim();
  if (looksLikeJwt(s)) return s;
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      const o = JSON.parse(s);
      const cand = o?.value ?? o?.token ?? o?.access_token ?? o?.value?.token ?? o?.data?.token;
      if (typeof cand === "string" && (looksLikeJwt(cand) || (keyedAsToken && cand.length > 20))) return cand.trim();
    } catch { /* not JSON */ }
  }
  if (keyedAsToken && s.length > 20 && !/\s/.test(s)) return s;
  return firstJwt(s);
}

function extractToken(localStore, cookie) {
  const entries = Object.entries(localStore || {});
  if (localStore.userToken) { const t = tokenFromValue(localStore.userToken, true); if (t) return t; }
  for (const [k, v] of entries) { if (/token/i.test(k)) { const t = tokenFromValue(v, true); if (t) return t; } }
  for (const [, v] of entries) { const t = tokenFromValue(v, false); if (t) return t; }
  if (typeof cookie === "string" && cookie) {
    const m = cookie.match(/(?:userToken|token)=([^;]+)/i);
    if (m) { const t = tokenFromValue(decodeURIComponent(m[1]), true); if (t) return t; }
    const j = firstJwt(cookie); if (j) return j;
  }
  return "";
}

async function readToken(client) {
  const json = await evaluate(client, "(function(){try{var ls={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);ls[k]=localStorage.getItem(k);}return JSON.stringify({ls:ls,cookie:document.cookie});}catch(e){return JSON.stringify({ls:{},cookie:''});}})()");
  let dump = { ls: {}, cookie: "" };
  try { dump = JSON.parse(String(json || "{}")); } catch { /* keep default */ }
  return extractToken(dump.ls, dump.cookie);
}

async function refreshWasm(jsUrls) {
  for (const url of jsUrls) {
    try {
      const js = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })).text();
      const m = js.match(/sha3_wasm_bg\.[a-f0-9]+\.wasm/);
      if (!m) continue;
      const wasmUrl = `https://fe-static.deepseek.com/chat/static/${m[0]}`;
      const buf = Buffer.from(await (await fetch(wasmUrl, { headers: { "User-Agent": "Mozilla/5.0" } })).arrayBuffer());
      if (buf.length > 1000) { fs.writeFileSync(WASM_OUT, buf); return wasmUrl; }
    } catch { /* try next */ }
  }
  return null;
}

async function main() {
  const browser = findBrowser();
  if (!browser) { console.error("No Chrome/Edge/Brave found."); process.exit(1); }
  fs.mkdirSync(PROFILE, { recursive: true });
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--remote-allow-origins=*",      // Chrome 111+ rejects CDP websockets without this
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--new-window",
    "https://chat.deepseek.com/"
  ];
  const child = spawn(browser, args, { stdio: "ignore" });
  child.on("exit", (code) => {
    // A window that flashes open and shuts usually means another Chrome/Edge is holding this profile.
    if (code !== null && code !== 0) console.error(`\n⚠️  Browser exited (code ${code}). If a window flashed and closed, close any Chrome/Edge using .ds_profile and retry.`);
  });
  console.log("Browser opened — log in to DeepSeek. Capturing token automatically...");
  let client;
  try {
    await cdpReady(PORT, 60);
    const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
    const target = targets.find((t) => t.type === "page" && String(t.url).includes("deepseek.com")) || targets.find((t) => t.type === "page");
    client = makeClient(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send("Runtime.enable");

    const deadline = Date.now() + TIMEOUT_MS;
    let token = "";
    while (Date.now() < deadline) {
      token = await readToken(client);
      if (token) break;
      await sleep(2000);
    }
    if (!token) { console.error("Timed out waiting for login."); process.exit(1); }

    fs.writeFileSync(TOKEN_FILE, token, "utf8");
    console.log("\n✅ Token captured and saved to .ds_token");
    console.log("   export DS_TOKEN=\"" + token.slice(0, 6) + "…\"  (full value in .ds_token)");

    // Opportunistic wasm refresh using the live page's own script URLs (bypasses the 403 on HTML).
    const jsUrls = await evaluate(client, "[...document.scripts].map(s=>s.src).filter(s=>/fe-static\\.deepseek\\.com\\/chat\\/static\\/.*\\.js/.test(s))") || [];
    const wasmUrl = await refreshWasm(jsUrls);
    console.log(wasmUrl ? `✅ Updated sha3_wasm_bg.wasm from ${wasmUrl}` : "ℹ️  Could not auto-refresh the wasm now (kept the bundled one).");
    console.log("\nTry it:  DS_TOKEN=$(cat .ds_token) node deepseek-client.example.js \"Ciao!\"");
  } finally {
    try { client?.ws.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
