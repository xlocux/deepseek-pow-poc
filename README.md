# DeepSeek Chat Proof-of-Work — explained & solved (POC)

A self-contained, dependency-free POC that reproduces the proof-of-work (PoW) that
`chat.deepseek.com` requires on its chat/file endpoints, plus documentation of **how the protection
works** and **how to implement it in your own JavaScript project**.

> For educational / interoperability research on a service you are authorized to use with your own
> account. Respect DeepSeek's Terms of Service and rate limits — behave like a single human user.

## TL;DR

- DeepSeek protects `POST /api/v0/chat/completion`, `/api/v0/file/upload_file`, and guest actions
  with a **proof-of-work** token sent in the `X-DS-PoW-Response` header.
- The PoW is **`DeepSeekHashV1`**: a linear preimage-counter search over a **custom Keccak-based
  hash** shipped as a ~26 KB WebAssembly module (`sha3_wasm_bg.wasm`). It is **not** standard
  SHA3-256 — that is the whole point of the obfuscation.
- `node demo.js` solves a real captured challenge and matches the exact answer the official web
  client produced.

## What DeepSeek did to protect the endpoints

1. **Server issues a challenge.** Before a protected call, the client does
   `POST /api/v0/chat/create_pow_challenge` with `{ "target_path": "/api/v0/chat/completion" }`.
   The server returns:

   ```json
   {
     "algorithm": "DeepSeekHashV1",
     "challenge": "957f078e…819e48",   // target hash (hex)
     "salt": "735d40e5adb8d0d03a1c",
     "difficulty": 144000,              // search upper bound
     "expire_at": 1792917239407,
     "signature": "e3ffcd56…cab08",     // server-signed, echoed back untouched
     "target_path": "/api/v0/chat/completion"
   }
   ```

2. **Client must find the answer.** The answer is the smallest integer `i` in `[0, difficulty)` with:

   ```
   prefix = `${salt}_${expire_at}_`
   DeepSeekHashV1(prefix + i) === challenge
   ```

   i.e. `challenge` is just the precomputed hash of `prefix + answer`; you brute-force the counter.
   Expected work ≈ `difficulty/… ` iterations (here it landed on **47450**).

3. **Client sends the answer back.** Base64 of this JSON goes in the `X-DS-PoW-Response` header on the
   protected request:

   ```json
   { "algorithm", "challenge", "salt", "answer", "signature", "target_path" }
   ```

4. **The anti-reverse trick.** The hash (`DeepSeekHashV1`) is **not** a standard algorithm — it is a
   custom Keccak variant (capacity 256) compiled to WebAssembly and run inside a **Web Worker**.
   The site ships both a wasm solver and a pure-JS fallback worker. Because it is not SHA3-256,
   `crypto.createHash('sha3-256')` never matches, so you cannot reimplement it by guessing.

## How we solved it

1. Captured a real request/response set (HAR) from a logged-in session: the challenge **and** the
   `X-DS-PoW-Response` the browser sent — decoding the header revealed the exact `answer` (47450)
   for a known challenge. That gave us a **ground-truth test vector**.
2. Downloaded the site's own PoW assets (`sha3_wasm_bg.*.wasm` and the worker chunk that calls it).
   The worker source revealed the exact formula: `prefix = `${salt}_${expire_at}_``, and the loop
   `hash(prefix + i) === challenge`.
3. Confirmed the hash is custom: `DeepSeekHashV1("abc") !== sha3-256("abc")`. So we **reuse
   DeepSeek's own wasm** as the hash oracle (no need to re-derive the Keccak parameters).
4. Wrote a ~40-line wasm-bindgen glue in Node to call `wasm_deepseek_hash_v1(str) -> hex`, then a
   trivial counter loop. It reproduces answer **47450** for the captured challenge in ~90 ms.

See [`pow.js`](./pow.js) for the solver and [`demo.js`](./demo.js) for the self-verifying POC.

## Files

| File | Purpose |
|---|---|
| `pow.js` | The solver: `solveChallenge`, `powResponseHeader`, `deepseekHashV1` (zero deps). |
| `demo.js` | Self-test against a real captured challenge → verifies answer `47450`. |
| `capture.js` | Opens a real browser, you log in once, auto-captures your `userToken` **and** refreshes the wasm. |
| `deepseek-client.example.js` | Minimal reference client: challenge → PoW → chat completion (SSE). |
| `update-wasm.js` | Best-effort headless refresh of the wasm (falls back to `capture.js` when the site 403s). |
| `sha3_wasm_bg.wasm` | DeepSeek's custom-hash wasm, used as the hash oracle. |
| `IMPLEMENTATION.md` | Step-by-step guide to wire this into your own JS project. |

## Run

```bash
node demo.js                 # verify the solver (no login needed)
node capture.js              # log in once -> saves .ds_token and refreshes the wasm
DS_TOKEN=$(cat .ds_token) node deepseek-client.example.js "Ciao!"
```

## Keeping it working (auto-update)

DeepSeek rotates `sha3_wasm_bg.<hash>.wasm` (and occasionally the algorithm) on updates. Instead of
re-capturing by hand:

- **`node capture.js`** — the reliable path. A real browser loads the (bot-protected) page, so it can
  read the current chunk URLs; the script then downloads the fresh wasm from the CDN and saves your
  token. Run it again whenever chat stops working.
- **`node update-wasm.js`** — headless; discovers the wasm from the site's JS and validates it against
  the known test vector. If DeepSeek has fronted the HTML with bot protection (HTTP 403) it tells you
  to use `capture.js` instead.
- The validator re-runs the **known test vector** after download: if it still matches, the algorithm
  is unchanged and the solver is safe; if not, DeepSeek changed the hash/flow and you must re-verify
  with a live challenge.

## Notes & ethics

- This defeats a **client-side** PoW only; the server still enforces auth (`Authorization: Bearer
  <userToken>`), rate limits, and the signed challenge. Use your **own** session, one request per
  action, serialized, with back-off.
- It will break whenever DeepSeek ships a new hash/wasm — re-capture the wasm + worker and update.
