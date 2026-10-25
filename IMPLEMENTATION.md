# Implementing DeepSeek PoW in your own JS project

A step-by-step guide to call DeepSeek's protected endpoints from your own Node (or browser) code,
using the solver in [`pow.js`](./pow.js). Everything runs with **zero npm dependencies** on Node 18+.

## 0. Prerequisites

- Your own **session token** (`userToken`) from a logged-in `chat.deepseek.com` tab:
  DevTools → Application → Local Storage → `chat.deepseek.com` → key `userToken`.
- The bundled `sha3_wasm_bg.wasm` next to `pow.js` (DeepSeek's custom hash oracle).
- A **stable** `x-device-id` (generate a UUID once and reuse it; a real browser keeps one).

## 1. Drop in the solver

Copy `pow.js` and `sha3_wasm_bg.wasm` into your project.

```js
const { powResponseHeader } = require("./pow");
```

## 2. Send browser-like headers on every call

DeepSeek expects the web client's headers. Send them all, and keep the device id stable:

```js
function dsHeaders(token, deviceId) {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Authorization": `Bearer ${token}`,
    "Origin": "https://chat.deepseek.com",
    "Referer": "https://chat.deepseek.com/",
    "x-client-platform": "web",
    "x-client-version": "2.7.0",
    "x-client-locale": "en_US",
    "x-client-timezone-offset": String(new Date().getTimezoneOffset() * -1),
    "x-device-id": deviceId,
    "x-device-model": "",
    "sec-ch-ua": '"Chromium";v="133", "Not(A:Brand";v="24", "Google Chrome";v="133"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin"
  };
}
```

## 3. The PoW flow (for any protected endpoint)

```js
// a) ask for a challenge scoped to the endpoint you will call
const challengeResp = await fetch("https://chat.deepseek.com/api/v0/chat/create_pow_challenge", {
  method: "POST",
  headers: { ...dsHeaders(token, deviceId), "Content-Type": "application/json" },
  body: JSON.stringify({ target_path: "/api/v0/chat/completion" })
}).then(r => r.json());
const challenge = challengeResp.data.biz_data.challenge;

// b) solve it -> base64 header value
const powHeader = powResponseHeader(challenge);

// c) call the protected endpoint with the X-DS-PoW-Response header
const res = await fetch("https://chat.deepseek.com/api/v0/chat/completion", {
  method: "POST",
  headers: { ...dsHeaders(token, deviceId), "Content-Type": "application/json", "X-DS-PoW-Response": powHeader },
  body: JSON.stringify({ chat_session_id, parent_message_id: null, model_type: "default",
    prompt, ref_file_ids: [], thinking_enabled: false, search_enabled: false, action: null, preempt: false })
});
```

Each protected endpoint needs its **own** challenge with the matching `target_path`
(e.g. `/api/v0/file/upload_file` for uploads).

## 4. Chat session + streaming response

1. `POST /api/v0/chat_session/create` with `{}` → `data.biz_data.chat_session.id`. Reuse it across
   messages; set `parent_message_id` to the previous `response_message_id` for multi-turn.
2. `POST /api/v0/chat/completion` returns **Server-Sent Events** (`text/event-stream`). The text
   arrives as `fragments[].content` plus incremental patches `{"p","o","v"}`; append `v` strings
   whose path ends in `content`. See `parseSse` in `deepseek-client.example.js`.

## 5. File upload (optional)

```js
const form = new FormData();
form.append("file", new Blob([buffer], { type: contentType }), fileName);
const pow = powResponseHeader(uploadChallenge); // challenge with target_path "/api/v0/file/upload_file"
const r = await fetch("https://chat.deepseek.com/api/v0/file/upload_file", {
  method: "POST",
  headers: { ...dsHeaders(token, deviceId), "X-DS-PoW-Response": pow }, // no Content-Type: let fetch set the boundary
  body: form
}).then(r => r.json());
const fileId = r.data.biz_data.id; // pass in ref_file_ids on the next completion
```

## 6. Behave responsibly

- **One request per user action**, serialized, with exponential back-off on `429`/`5xx`.
- Reuse one chat session; don't poll; don't parallelize.
- Treat the token like a password; never log it. It expires — refresh by re-reading `userToken`.
- This bypasses a **client-side** check only; the server still enforces auth, the signed challenge,
  and rate limits. Only use it against your own authorized account and within DeepSeek's ToS.

## Browser usage

The same flow works in a browser **from DeepSeek's own origin** (where `fetch` sends the session
cookie/headers and you can `WebAssembly.instantiateStreaming(fetch(wasmUrl))`). From a different
origin, CORS blocks it — run it server-side (as above) with the user's token.
