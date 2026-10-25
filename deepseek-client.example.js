"use strict";

// Minimal reference client for chat.deepseek.com using the PoW solver in pow.js.
// Educational interoperability POC — use YOUR OWN logged-in session token.
//
// Usage:
//   DS_TOKEN="<your userToken>" node deepseek-client.example.js "Ciao, come stai?"
//
// Get your token: log in at chat.deepseek.com → DevTools → Application → Local Storage →
// chat.deepseek.com → key `userToken`.

const crypto = require("node:crypto");
const { powResponseHeader } = require("./pow");

const BASE = "https://chat.deepseek.com/api/v0";
const TOKEN = process.env.DS_TOKEN;
const DEVICE_ID = process.env.DS_DEVICE_ID || crypto.randomUUID(); // keep this STABLE across calls
const PROMPT = process.argv.slice(2).join(" ") || "Say hello in one short sentence.";

// Realistic browser headers so the request looks like the real web client (one user, no flooding).
function headers() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Authorization": `Bearer ${TOKEN}`,
    "Origin": "https://chat.deepseek.com",
    "Referer": "https://chat.deepseek.com/",
    "x-client-platform": "web",
    "x-client-version": "2.7.0",
    "x-client-locale": "en_US",
    "x-client-timezone-offset": String(new Date().getTimezoneOffset() * -1),
    "x-device-id": DEVICE_ID,
    "x-device-model": "",
    "sec-ch-ua": '"Chromium";v="133", "Not(A:Brand";v="24", "Google Chrome";v="133"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin"
  };
}

async function postJson(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`${pathname}: ${data.msg || res.status}`);
  return data.data.biz_data;
}

// Parse the SSE completion stream into text (fragments + incremental v/p/o patches).
function parseSse(sse) {
  let text = "";
  let appendable = false;
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw) continue;
    let obj; try { obj = JSON.parse(raw); } catch { continue; }
    if (obj.v && typeof obj.v === "object" && obj.v.response) {
      for (const f of obj.v.response.fragments || []) if (f.type === "RESPONSE") text += f.content || "";
      appendable = true;
    } else if (typeof obj.p === "string") {
      appendable = /content$/.test(obj.p) || obj.p.includes("fragments");
      if (appendable && typeof obj.v === "string") text += obj.v;
    } else if (typeof obj.v === "string" && appendable) {
      text += obj.v;
    }
  }
  return text.trim();
}

async function main() {
  if (!TOKEN) { console.error("Set DS_TOKEN to your chat.deepseek.com userToken."); process.exit(1); }

  // 1) Create (or reuse) a chat session.
  const session = await postJson("/chat_session/create", {});
  const sessionId = session.chat_session.id;

  // 2) Get a PoW challenge for the completion endpoint and solve it.
  const { challenge } = await postJson("/chat/create_pow_challenge", { target_path: "/api/v0/chat/completion" });
  const pow = powResponseHeader(challenge);

  // 3) Send the message with the PoW header; read the SSE stream.
  const res = await fetch(`${BASE}/chat/completion`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json", "X-DS-PoW-Response": pow },
    body: JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: null,
      model_type: "default",
      prompt: PROMPT,
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false,
      action: null,
      preempt: false
    })
  });
  const sse = await res.text();
  console.log("DeepSeek:", parseSse(sse));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
