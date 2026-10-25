"use strict";

// Auto-refresh DeepSeek's PoW hash wasm. DeepSeek rotates `sha3_wasm_bg.<hash>.wasm` on updates;
// this discovers the current one from the live site, downloads it, and validates it.
//
//   node update-wasm.js
//
// Discovery: load chat.deepseek.com, find its JS chunks on fe-static.deepseek.com, and grep them
// for the current `sha3_wasm_bg.<hash>.wasm` filename, then download it.

const fs = require("node:fs");
const path = require("node:path");

const STATIC_BASE = "https://fe-static.deepseek.com/chat/static/";
const OUT = path.join(__dirname, "sha3_wasm_bg.wasm");

// Known test vector from a captured challenge — proves the downloaded hash still matches our solver.
const VECTOR = {
  salt: "735d40e5adb8d0d03a1c",
  expire_at: 1792917239407,
  answer: 47450,
  challenge: "957f078efa8c32b4675cb75e4f80e8b9a5aecbedc0ff07cf5637c6e75f819e48"
};

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

async function text(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (res.status === 403) {
    throw new Error(`GET ${url} -> 403 (bot protection). Use "node capture.js" — a real browser bypasses this and also refreshes the wasm.`);
  }
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function findWasmUrl() {
  const html = await text("https://chat.deepseek.com/");
  const urls = new Set();
  const push = (u) => urls.add(u.startsWith("http") ? u : `https://fe-static.deepseek.com${u}`);
  for (const m of html.matchAll(/https:\/\/fe-static\.deepseek\.com\/chat\/static\/[\w.\-]+\.js/g)) push(m[0]);
  for (const m of html.matchAll(/["'](\/chat\/static\/[\w.\-]+\.js)["']/g)) push(m[1]);
  // Check 'main' chunks first — that's where the wasm reference lives.
  const ordered = [...urls].sort((a, b) => (b.includes("main") ? 1 : 0) - (a.includes("main") ? 1 : 0));
  for (const url of ordered.slice(0, 15)) {
    try {
      const js = await text(url);
      const m = js.match(/sha3_wasm_bg\.[a-f0-9]+\.wasm/);
      if (m) return STATIC_BASE + m[0];
    } catch { /* try the next chunk */ }
  }
  throw new Error("Could not find sha3_wasm_bg.*.wasm in DeepSeek's current assets");
}

function hashOf(buffer, str) {
  const ex = new WebAssembly.Instance(new WebAssembly.Module(buffer), {}).exports;
  const ret = ex.__wbindgen_add_to_stack_pointer(-16);
  const b = new TextEncoder().encode(str);
  const p = ex.__wbindgen_export_0(b.length, 1);
  new Uint8Array(ex.memory.buffer).set(b, p);
  ex.wasm_deepseek_hash_v1(ret, p, b.length);
  const view = new DataView(ex.memory.buffer);
  const hex = Buffer.from(new Uint8Array(ex.memory.buffer, view.getInt32(ret, true), view.getInt32(ret + 4, true))).toString("ascii");
  ex.__wbindgen_add_to_stack_pointer(16);
  return hex;
}

async function main() {
  console.log("Discovering current DeepSeek PoW wasm...");
  const wasmUrl = await findWasmUrl();
  console.log("Found:", wasmUrl);
  const res = await fetch(wasmUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  // Validate against the known vector: same hash function => same algorithm, safe to ship.
  const ok = hashOf(buffer, `${VECTOR.salt}_${VECTOR.expire_at}_${VECTOR.answer}`) === VECTOR.challenge;
  fs.writeFileSync(OUT, buffer);
  console.log(`Saved ${buffer.length} bytes -> ${OUT}`);
  if (ok) {
    console.log("✅ Validated: hash matches the known test vector — solver is compatible.");
  } else {
    console.log("⚠️  Downloaded, but the hash no longer matches the known vector. DeepSeek likely");
    console.log("    changed the algorithm; the message prefix/flow may also have changed. Re-verify");
    console.log("    with a LIVE challenge (needs a session token) before trusting the solver.");
  }
}

main().catch((e) => { console.error("Update failed:", e.message); process.exit(1); });
