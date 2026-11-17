// B5 rig tests — the AD4M user's Acorn profile (create/update through the
// mount model API), the project identity interactions (info's agentDid,
// whoami, sendRealtimeInfo, announceJoin), and the own member's
// acorn://sameAs link to the AD4M DID.
// Needs rig/start.sh running (rig/.run/env present). Stock sees AD4M writes
// in about 10 s on a fresh rig, but gossip slows as a warmed rig accumulates
// app installs, so the stock-side polls carry generous bounds.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createRequire } from "node:module";
import * as ad4m from "../ad4m.mjs";
import { rigEnv, REPO_DIR } from "../envfile.mjs";
import * as stock from "../stock.mjs";

const env = rigEnv();
const BASE_BUNDLE = join(REPO_DIR, "language", "build", "bundle.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AgentPubKeyB64 <-> did:key, the same math as language/src/agent.ts. The
// rig package has no blakejs of its own; resolve the language's copy.
const langRequire = createRequire(join(REPO_DIR, "language", "package.json"));
const { blake2b } = langRequire("blakejs");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const AGENT_PREFIX = [0x84, 0x20, 0x24];
const ED25519_MULTICODEC = [0xed, 0x01];

function base58Encode(bytes) {
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

function base58Decode(s) {
  const bytes = [0];
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`bad base58 character ${JSON.stringify(ch)}`);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      const n = bytes[i] * 58 + carry;
      bytes[i] = n & 0xff;
      carry = n >> 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  for (const ch of s) {
    if (ch === "1") zeros++;
    else break;
  }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

// "u" + base64url -> bytes (holo.ts b64ToBytes).
function b64ToBytes(s) {
  const body = s.startsWith("u") ? s.slice(1) : s;
  const clean = body.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const ch = clean[i + k];
      n = (n << 6) | (ch === undefined ? 0 : B64URL.indexOf(ch));
    }
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out.subarray(0, o);
}
const B64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function bytesToB64(u8) {
  let out = "u";
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i];
    const b = u8[i + 1];
    const c = u8[i + 2];
    const n = (a << 16) | (((b ?? 0) || 0) << 8) | ((c ?? 0) || 0);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
    if (b !== undefined) out += B64URL[(n >> 6) & 63];
    if (c !== undefined) out += B64URL[n & 63];
  }
  return out;
}

function agentToDid(b64) {
  const raw = b64ToBytes(b64);
  const key = raw.slice(3, 35);
  return "did:key:z" + base58Encode(new Uint8Array([...ED25519_MULTICODEC, ...key]));
}

function didToAgent(did) {
  const decoded = base58Decode(did.slice("did:key:z".length));
  const key = decoded.slice(2);
  const h = blake2b(key, undefined, 16);
  const loc = new Uint8Array([h[0], h[1], h[2], h[3]]);
  for (let i = 4; i < 16; i += 4) {
    loc[0] ^= h[i];
    loc[1] ^= h[i + 1];
    loc[2] ^= h[i + 2];
    loc[3] ^= h[i + 3];
  }
  return bytesToB64(new Uint8Array([...AGENT_PREFIX, ...key, ...loc]));
}

assert.ok(
  env.SEED && env.STOCK_DNA && env.STOCK_AGENT && env.AD4M_DATA && env.AD4M_AGENT_DID,
  "rig/.run/env missing or incomplete — start rig/start.sh first"
);

let S = null; // stock connection {adminWs, app, cid, agent, dna}
let L = null; // language address
let uuid = null; // perspective uuid
let OWN = null; // the language cell's AgentPubKeyB64 (the AD4M user's Acorn key)
let INFO = null; // last `info` result

const url = (h) => `${L}://${h}`;
const profileUrl = () => `${L}://profile/${OWN}`;

// ---- helpers ---------------------------------------------------------------

async function createSubject(className, initialValues) {
  const res = await ad4m.rpc(
    "perspective.createSubject",
    {
      uuid,
      subjectClass: className,
      expressionAddress: "ignored",
      initialValues: JSON.stringify(initialValues),
    },
    120000
  );
  assert.equal(
    typeof res,
    "string",
    `createSubject ${className} returned ${JSON.stringify(res)}`
  );
  assert.match(res, new RegExp(`^${L.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}://`));
  return res;
}

function updateSubject(className, address, values) {
  return ad4m.rpc(
    "perspective.updateSubject",
    {
      uuid,
      subjectClass: className,
      expressionAddress: url(address),
      values: JSON.stringify(values),
    },
    120000
  );
}

const fetchAgents = () =>
  stock.stockCall(S, "profiles", "fetch_agents", { input: null, local: true });

async function modelQuery(className) {
  const res = await ad4m.rpc(
    "perspective.modelQuery",
    { uuid, class_name: className, query_json: "{}" },
    120000
  );
  const parsed = typeof res === "string" ? JSON.parse(res) : res;
  return parsed?.instances ?? parsed ?? [];
}

async function until(read, accept, timeoutMs, what) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await read();
      const acc = accept(last);
      if (acc) return acc === true ? last : acc;
    } catch {
      // not gossiped yet
    }
    await sleep(1000);
  }
  throw new Error(`${what}: not satisfied after ${timeoutMs}ms`);
}

// ---- tests -----------------------------------------------------------------

test("setup: mount the language on a fresh perspective", async (t) => {
  // stock.connect() awaits holochain-client calls with no internal
  // timeout; a wedged call once left a test hanging for the whole run,
  // so bound it and retry on a fresh socket.
  for (let attempt = 0; ; attempt++) {
    try {
      S = await Promise.race([
        stock.connect(),
        sleep(30000).then(() => {
          throw new Error("stock.connect timed out");
        }),
      ]);
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      await stock.closeStock(null).catch(() => {});
      await sleep(2000);
    }
  }
  const base = ad4m.publishLocal(BASE_BUNDLE, { name: "acorn" });
  const t0 = Date.now();
  let ref = null;
  let lastErr = null;
  while (Date.now() - t0 < 180000) {
    try {
      ref = await ad4m.applyTemplateLocal(base, { seed: env.SEED });
      break;
    } catch (e) {
      lastErr = e;
      await sleep(5000);
    }
  }
  assert.ok(ref, `applyTemplateLocal never succeeded: ${lastErr?.message}`);
  L = ref.address;
  const info = await ad4m.waitForInfo(`${L}://project`, 180000);
  assert.equal(info.dnaHash, env.STOCK_DNA);
  OWN = info.agentPubKey;
  assert.ok(OWN && OWN.startsWith("uh"), `own agent key ${OWN}`);

  const handle = await ad4m.rpc("perspective.create", { name: "b5 mount" });
  uuid = handle.uuid;
  try {
    await ad4m.rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
  } catch (e) {
    await sleep(5000);
    await ad4m.rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
  }
  t.diagnostic(`mounted ${L} on ${uuid}; own agent ${OWN}`);
});

test("createSubject AcornProfile returns profile/<ownKey> and stock sees it", async (t) => {
  const pUrl = await createSubject("AcornProfile", {
    firstName: "Ada",
    lastName: "AD4M",
    handle: "ada",
    avatarUrl: "",
  });
  assert.equal(pUrl, profileUrl());
  // AD4M->stock is the fast gossip direction (~10 s on a fresh rig), but
  // a rig that has accumulated app installs can take minutes — the first
  // write gets a wide bound; a still-growing rig keeps honest failures.
  const mine = await until(
    fetchAgents,
    (rows) => rows.find((p) => p.handle === "ada" && p.agentPubKey === OWN),
    180000,
    "stock fetch_agents has the AD4M profile"
  );
  assert.equal(mine.firstName, "Ada");
  assert.equal(mine.status, "Online");
  assert.equal(mine.isImported, false);
  t.diagnostic(`profile visible to stock: ${JSON.stringify(mine)}`);
});

test("updateSubject AcornProfile {handle:'ada2'} keeps firstName", async () => {
  await updateSubject("AcornProfile", `profile/${OWN}`, { handle: "ada2" });
  const mine = await until(
    fetchAgents,
    (rows) => rows.find((p) => p.agentPubKey === OWN && p.handle === "ada2"),
    120000,
    "stock fetch_agents shows handle ada2"
  );
  assert.equal(mine.firstName, "Ada");
  assert.equal(mine.lastName, "AD4M");
});

test("project whoami returns the own profile address and data", async () => {
  const w = await ad4m.interact(`${L}://project`, "whoami", {});
  assert.ok(w, "whoami returned null");
  assert.equal(w.address, `profile/${OWN}`);
  assert.equal(w.data.handle, "ada2");
  assert.equal(w.data.firstName, "Ada");
  assert.equal(w.data.agentPubKey, OWN);
  assert.equal(w.data.agent, agentToDid(OWN));
});

test("announceJoin and sendRealtimeInfo return without error; info.agentDid maps to the key", async (t) => {
  await ad4m.interact(`${L}://project`, "announceJoin", {});
  await ad4m.interact(`${L}://project`, "sendRealtimeInfo", {
    projectId: env.SEED,
    outcomeBeingEdited: null,
    outcomeExpandedView: null,
  });

  INFO = await ad4m.interact(`${L}://project`, "info", {});
  assert.ok(INFO.agentDid?.startsWith("did:key:z6Mk"), `agentDid ${INFO.agentDid}`);
  assert.equal(didToAgent(INFO.agentDid), INFO.agentPubKey);
  assert.equal(agentToDid(INFO.agentPubKey), INFO.agentDid);
  assert.equal(INFO.agentPubKey, OWN);
  t.diagnostic(`agentDid ${INFO.agentDid}; ad4mDid ${INFO.ad4mDid}`);
});

test("exactly one member carries acorn://sameAs -> the AD4M DID", async (t) => {
  // modelQuery hydrates the mount's record properties: exactly one member
  // — the own one — has sameAs, and it is the AD4M DID.
  const members = await modelQuery("AcornMember");
  const withSameAs = members.filter((m) => m.sameAs != null);
  assert.equal(
    withSameAs.length,
    1,
    `members with sameAs: ${JSON.stringify(withSameAs)}`
  );
  assert.equal(withSameAs[0].sameAs, env.AD4M_AGENT_DID);
  assert.equal(withSameAs[0].agent, agentToDid(OWN));

  // the brief's check is on the SPARQL store: the wire answer is a bare
  // array of bindings (not {results:{bindings}}). Still poll briefly —
  // the mount's record links land with the mount, but a resync pass is
  // the backstop if the first sync raced the mount RPC.
  const query = `SELECT ?m ?s WHERE { ?m <acorn://sameAs> ?s }`;
  const val = (b, k) => b?.[k]?.value ?? b?.[k];
  const bindings = await until(
    async () => {
      const res = await ad4m.rpc(
        "perspective.querySparql",
        { uuid, query },
        120000
      );
      const parsed = typeof res === "string" ? JSON.parse(res) : res;
      return Array.isArray(parsed) ? parsed : (parsed?.results?.bindings ?? []);
    },
    (rows) => rows.some((b) => val(b, "s") === env.AD4M_AGENT_DID) && rows,
    120000,
    "a sameAs triple to the AD4M DID"
  );
  t.diagnostic(`sameAs bindings: ${JSON.stringify(bindings)}`);
  const rows = bindings.filter((b) => val(b, "s") === env.AD4M_AGENT_DID);
  assert.equal(
    rows.length,
    1,
    `expected exactly one sameAs row to ${env.AD4M_AGENT_DID}, got ${JSON.stringify(bindings)}`
  );
  assert.ok(
    String(val(rows[0], "m")).startsWith(`${L}://`),
    `member subject is a language URL: ${JSON.stringify(rows[0])}`
  );
  // no other member may carry a sameAs (the stock member, once it gossips
  // in, is not this executor's own key either)
  const others = bindings.filter(
    (b) => !String(val(b, "m")).startsWith(`${L}://`) || val(b, "s") !== env.AD4M_AGENT_DID
  );
  assert.equal(
    others.length,
    0,
    `unexpected sameAs rows: ${JSON.stringify(others)}`
  );
});

test.after(async () => {
  if (S) await stock.closeStock(S);
  ad4m.close();
});
