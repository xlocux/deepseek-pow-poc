"use strict";

// Self-contained POC: solves a REAL DeepSeek challenge captured from the live site and verifies the
// answer matches the one DeepSeek's own browser produced. Run: `node demo.js`

const { solveChallenge, powResponseHeader, deepseekHashV1 } = require("./pow");

// A real challenge captured from chat.deepseek.com, with the answer the official web client sent.
const CHALLENGE = {
  algorithm: "DeepSeekHashV1",
  challenge: "957f078efa8c32b4675cb75e4f80e8b9a5aecbedc0ff07cf5637c6e75f819e48",
  salt: "735d40e5adb8d0d03a1c",
  difficulty: 144000,
  expire_at: 1792917239407,
  signature: "e3ffcd562401eccafa6563c1b892c2e28fbfbeae205bd6d2a4a52829e86cab08",
  target_path: "/api/v0/chat/completion"
};
const EXPECTED_ANSWER = 47450;

console.log("DeepSeek custom hash is NOT standard SHA3-256:");
console.log("  deepseekHashV1('abc') =", deepseekHashV1("abc"));
console.log();

const t0 = Date.now();
const answer = solveChallenge(CHALLENGE);
const ms = Date.now() - t0;

console.log(`Solved PoW in ${ms}ms -> answer = ${answer}`);
console.log(`Expected answer       = ${EXPECTED_ANSWER}`);
console.log(answer === EXPECTED_ANSWER ? "✅ MATCH — solver is correct" : "❌ MISMATCH");
console.log();
console.log("X-DS-PoW-Response header value (base64):");
console.log(" ", powResponseHeader(CHALLENGE));

process.exit(answer === EXPECTED_ANSWER ? 0 : 1);
