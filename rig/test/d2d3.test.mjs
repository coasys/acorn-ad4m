// D2/D3 rig tests — a generic AD4M script (demo/we-sees-acorn.mjs) reads
// mounted records through the built-in abstract classes ad4m://TextContent
// and ad4m://Container, and renames an outcome through TextContent — the
// polymorphic write of design §3.5 from outside the language. The script
// itself has no Acorn code (the grep test proves it); the stock side
// checks the write landed.
// Needs rig/start.sh running (rig/.run/env present). Stock->AD4M is the
// slow gossip direction on a cold 2-node net (step-0 notes), so the
// mount-side polls bound at 300 s like B2; the AD4M->stock write gets the
// brief's 30 s.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ad4m from "../ad4m.mjs";
import { rigEnv, REPO_DIR } from "../envfile.mjs";
import * as stock from "../stock.mjs";

const env = rigEnv();
const BASE_BUNDLE = join(REPO_DIR, "language", "build", "bundle.js");
const SCRIPT = join(REPO_DIR, "demo", "we-sees-acorn.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

assert.ok(
  env.SEED && env.STOCK_DNA && env.STOCK_AGENT && env.AD4M_DATA,
  "rig/.run/env missing or incomplete — start rig/start.sh first"
);

const P_CONTENT = "parent outcome P";
const C_CONTENT = "child outcome C";
const COMMENT_CONTENT = "a comment on P";
const RENAMED = "renamed by WE";

let S = null; // stock connection {adminWs, app, cid, agent, dna}
let L = null; // language address
let uuid = null; // perspective uuid
let P = null; // outcome P actionHash (b64)
let C = null; // outcome C actionHash

const url = (h) => `${L}://${h}`;

// Run the demo script as a child process (as a real app would) and return
// its stdout. execFileSync throws on a non-zero exit, so a script failure
// is a test failure with the stderr attached.
const runScript = (args) =>
  execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 120000,
  });

// The same abstract queries the script runs, used to wait out gossip
// before invoking it (modelQuery params are snake_case on the wire —
// PerspectiveModelQueryParams).
async function modelQuery(className) {
  const res = await ad4m.rpc(
    "perspective.modelQuery",
    { uuid, class_name: className, query_json: "{}" },
    180000
  );
  const parsed = typeof res === "string" ? JSON.parse(res) : res;
  return parsed?.instances ?? [];
}

async function untilRows(className, accept, timeoutMs, what) {
  const t0 = Date.now();
  let rows = [];
  while (Date.now() - t0 < timeoutMs) {
    try {
      rows = await modelQuery(className);
      if (accept(rows)) return rows;
    } catch {
      // the mount sync may not have produced shapes/instances yet
    }
    await sleep(3000);
  }
  throw new Error(
    `${what}: not satisfied after ${timeoutMs}ms (last rows: ${JSON.stringify(rows)})`
  );
}

const outcomes = () =>
  stock.stockCall(S, "projects", "fetch_outcomes", {
    input: { All: null },
    local: true,
  });
const findOutcome = async (h) => (await outcomes()).find((r) => r.actionHash === h);

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

test("setup: stock creates P with child C and a comment; AD4M mounts", async (t) => {
  S = await stock.connect();
  const recP = await stock.createOutcome(S, P_CONTENT);
  P = recP.actionHash;
  C = (await stock.createOutcomeUnder(S, P, C_CONTENT)).actionHash;
  await stock.createComment(S, P, COMMENT_CONTENT);

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

  const handle = await ad4m.rpc("perspective.create", { name: "d2d3 mount" });
  uuid = handle.uuid;
  try {
    await ad4m.rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
  } catch (e) {
    await sleep(5000);
    await ad4m.rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
  }
  t.diagnostic(`mounted ${L} on ${uuid}; P=${P} C=${C}`);

  // P, C and the comment arrive through stock->AD4M gossip + the mount
  // resync; the script is run only once the data is there.
  await untilRows(
    "ad4m://TextContent",
    (rows) =>
      rows.some((r) => r.id === url(P) && r.text === P_CONTENT) &&
      rows.some((r) => r.id === url(C) && r.text === C_CONTENT) &&
      rows.some((r) => r.text === COMMENT_CONTENT),
    300000,
    "ad4m://TextContent shows P, C and the comment"
  );
  await untilRows(
    "ad4m://Container",
    (rows) => {
      const p = rows.find((r) => r.id === url(P));
      return Array.isArray(p?.children) && p.children.includes(url(C));
    },
    300000,
    "ad4m://Container shows C under P"
  );
});

test("D2 lists outcomes and comments as text", () => {
  const out = runScript([uuid]);
  assert.ok(out.includes(P_CONTENT), `P's content missing:\n${out}`);
  assert.ok(out.includes(C_CONTENT), `C's content missing:\n${out}`);
  assert.ok(out.includes(COMMENT_CONTENT), `comment text missing:\n${out}`);
});

test("D2 lists children", () => {
  const out = runScript([uuid]);
  const line = out
    .split("\n")
    .find((l) => l.includes(url(P)) && l.includes(url(C)));
  assert.ok(line, `no line shows ${url(C)} among ${url(P)}'s children:\n${out}`);
});

test("D3 renames through TextContent; stock sees only content change", async (t) => {
  const before = (await findOutcome(C))?.entry;
  assert.ok(before, `stock has no outcome ${C}`);

  const out = runScript([uuid, "--rename", url(C), RENAMED]);
  assert.ok(out.includes(RENAMED), `the re-printed row is missing:\n${out}`);

  const rec = await until(
    () => findOutcome(C),
    (r) => r?.entry.content === RENAMED,
    30000,
    "stock fetch_outcomes shows C renamed"
  );
  const after = rec.entry;
  // content is the field under test; editorAgentPubKey/timestampUpdated are
  // the UI's per-update stamp the language's update path also sets. Every
  // other field must be byte-identical (same exception as b3).
  const {
    content: _c1,
    editorAgentPubKey: _e1,
    timestampUpdated: _t1,
    ...restBefore
  } = before;
  const {
    content: _c2,
    editorAgentPubKey: _e2,
    timestampUpdated: _t2,
    ...restAfter
  } = after;
  assert.deepEqual(restAfter, restBefore);
  t.diagnostic(`stock C renamed after ${JSON.stringify(after.content)}`);
});

test("the script has no Acorn code", () => {
  // the reviewer's grep: `grep -i acorn demo/we-sees-acorn.mjs | grep -v '^\s*//'`
  // — case-insensitive "acorn" on any line that is not a pure // comment.
  const hits = readFileSync(SCRIPT, "utf8")
    .split("\n")
    .filter((l) => /acorn/i.test(l) && !/^\s*\/\//.test(l));
  assert.deepEqual(hits, []);
});

test.after(async () => {
  if (S) await stock.closeStock(S);
  ad4m.close();
});
