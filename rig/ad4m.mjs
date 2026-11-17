// AD4M side driver: JSON-RPC over ws://127.0.0.1:<AD4M_PORT>/api/v1/ws
// (frame format: {id, type: <method>, params} -> {id, result|error}),
// plus the local-publish/template helpers the rig tests use.
//
//   import * as ad4m from "./ad4m.mjs";
//   await ad4m.rpc("agent.status");
//   const base = await ad4m.publishLocal("language/build/bundle.js");
//   const { address: L } = await ad4m.applyTemplateLocal(base, { seed });
//   const info = await ad4m.interact(`${L}://project`, "info", {});
import WebSocket from "ws";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { rigEnv } from "./envfile.mjs";

let _env = null;
function env() {
  if (!_env) _env = rigEnv();
  return _env;
}

// ---- ws rpc --------------------------------------------------------------

let ws = null;
let wsReady = null;
let nextId = 1;
const pending = new Map();
const listeners = new Set();

function connect() {
  if (wsReady) return wsReady;
  const port = env().AD4M_PORT || "45400";
  ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else {
      // event frames (query-subscription-update, link-added, …) carry no
      // pending id — fan them out to listeners
      for (const cb of listeners) cb(msg);
    }
  });
  wsReady = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  return wsReady;
}

export function rpc(method, params = {}, timeoutMs = 120000) {
  return connect().then(
    () =>
      new Promise((resolve, reject) => {
        const id = String(nextId++);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, (m) => {
          clearTimeout(timer);
          if (m.error) reject(new Error(`${method}: ${JSON.stringify(m.error)}`));
          else resolve(m.result);
        });
        ws.send(JSON.stringify({ id, type: method, params }));
      })
  );
}

export function close() {
  if (ws) ws.close();
  ws = null;
  wsReady = null;
  listeners.clear();
}

// Every frame that is not an rpc reply, live query updates included
// (they bypass events.watch but only reach the socket that opened them).
export function onEvent(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---- language bundle addressing ------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const n = (digits[i] << 8) + carry;
      digits[i] = n % 58;
      carry = (n / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const b of bytes) {
    if (b === 0) out += "1";
    else break;
  }
  return out + digits.reverse().map((d) => B58[d]).join("");
}

// The executor's language address:
// "Qm" + multibase-z + base58btc(CIDv1(codec 0x00, sha2-256(bundle)))
// — rust-executor/src/languages/mod.rs calculate_language_hash.
export function languageAddress(bundleSource) {
  const digest = createHash("sha256").update(bundleSource, "utf8").digest();
  const cid = Buffer.concat([Buffer.from([0x01, 0x00, 0x12, 0x20]), digest]);
  return "Qmz" + base58(cid);
}

function languagesDir() {
  return join(env().AD4M_DATA, "ad4m", "languages");
}

// Copy a bundle into the executor's languages dir the way language.publish
// leaves it (content-addressed dir + meta.json) but without publishing to
// the language language. Only safe for bundles with no secret — callers
// must use this ONLY on the un-templated base bundle.
export function publishLocal(bundlePath, meta = { name: "acorn" }) {
  const bundle = readFileSync(bundlePath, "utf8");
  const address = languageAddress(bundle);
  const dir = join(languagesDir(), address);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bundle.js"), bundle);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  return address;
}

// ---- helpers --------------------------------------------------------------

export function agentGenerate(passphrase) {
  return rpc("agent.generate", { passphrase }, 180000);
}

export function applyTemplateLocal(sourceLanguageHash, templateData) {
  return rpc(
    "language.applyTemplateLocal",
    {
      sourceLanguageHash,
      templateData: JSON.stringify(templateData),
    },
    300000
  );
}

// expression.interact -> the interaction's return value, JSON.parse'd.
export async function interact(url, name, params, timeoutMs = 120000) {
  const result = await rpc(
    "expression.interact",
    {
      url,
      interactionCall: {
        name,
        parametersStringified: JSON.stringify(params ?? {}),
      },
    },
    timeoutMs
  );
  if (typeof result !== "string") return result;
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

// Poll interact(url,"info",{}) until it answers with a dnaHash or timeout.
export async function waitForInfo(url, timeoutMs = 120000, stepMs = 3000) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const info = await interact(url, "info", {}, 30000);
      if (info && info.dnaHash) return info;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(
    `waitForInfo: no info after ${timeoutMs}ms` +
      (lastErr ? ` (last: ${lastErr.message})` : "")
  );
}

// ---- CLI sugar ------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] || "status";
  try {
    if (cmd === "generate") {
      console.log(
        "agent.generate:",
        JSON.stringify(await agentGenerate(process.argv[3] || "rig-passphrase"))
      );
    } else if (cmd === "status") {
      console.log(JSON.stringify(await rpc("agent.status"), null, 2));
    } else if (cmd === "langs") {
      for (const l of await rpc("language.all")) console.log(l.address, l.name);
    } else {
      console.log("usage: ad4m.mjs generate [pass]|status|langs");
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  close();
}
