"use strict";

// DeepSeek "DeepSeekHashV1" proof-of-work solver (Node, zero dependencies).
//
// DeepSeek's chat API protects endpoints (chat completion, file upload, guest actions) with a
// proof-of-work header. The server hands you a challenge; you must compute an `answer` and send it
// back base64-encoded in the `X-DS-PoW-Response` header. The hash used is DeepSeek's own
// Keccak-based function shipped as a tiny WebAssembly module (`sha3_wasm_bg.wasm`) — it is NOT
// standard SHA3-256, which is why a plain `crypto.createHash('sha3-256')` never reproduces it.
//
// Algorithm (reverse-engineered from the site's own PoW web worker):
//   prefix = `${salt}_${expire_at}_`
//   answer = the smallest integer i in [0, difficulty) such that
//            deepseekHashV1(prefix + i) === challenge
//
// `challenge` is simply the precomputed hash of `prefix + answer`, so solving is a linear
// preimage-counter search bounded by `difficulty`.

const fs = require("node:fs");
const path = require("node:path");

let wasm = null;

function loadWasm(wasmPath = path.join(__dirname, "sha3_wasm_bg.wasm")) {
  if (wasm) return wasm;
  const bytes = fs.readFileSync(wasmPath);
  const ex = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
  const malloc = ex.__wbindgen_export_0;            // wasm-bindgen malloc(size, align)
  const addStack = ex.__wbindgen_add_to_stack_pointer;
  const enc = new TextEncoder();
  // deepseekHashV1(str) -> 64-char hex digest
  const hash = (str) => {
    const ret = addStack(-16);
    const b = enc.encode(str);
    const p = malloc(b.length, 1);
    new Uint8Array(ex.memory.buffer).set(b, p);
    ex.wasm_deepseek_hash_v1(ret, p, b.length);
    const view = new DataView(ex.memory.buffer);
    const outPtr = view.getInt32(ret, true);
    const outLen = view.getInt32(ret + 4, true);
    const hex = Buffer.from(new Uint8Array(ex.memory.buffer, outPtr, outLen)).toString("ascii");
    addStack(16);
    return hex;
  };
  wasm = { hash };
  return wasm;
}

// Solve a challenge object: { algorithm, challenge, salt, difficulty, expire_at, signature, target_path }
function solveChallenge(challenge, wasmPath) {
  if (challenge.algorithm !== "DeepSeekHashV1") {
    throw new Error(`Unsupported PoW algorithm: ${challenge.algorithm}`);
  }
  const { hash } = loadWasm(wasmPath);
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const target = challenge.challenge;
  const max = Number(challenge.difficulty);
  for (let i = 0; i < max; i += 1) {
    if (hash(prefix + i) === target) return i;
  }
  throw new Error("No PoW solution found within difficulty");
}

// Build the value for the `X-DS-PoW-Response` header (base64 of the answer JSON).
function powResponseHeader(challenge, wasmPath) {
  const answer = solveChallenge(challenge, wasmPath);
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

// Expose the raw hash too, for experimentation.
function deepseekHashV1(str, wasmPath) {
  return loadWasm(wasmPath).hash(str);
}

module.exports = { solveChallenge, powResponseHeader, deepseekHashV1 };
