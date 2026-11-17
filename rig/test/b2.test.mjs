// B2 rig tests — the Acorn language mounted on an AD4M perspective reads the
// records a stock Acorn conductor wrote: mountShapes + mountSnapshot +
// expressionGet, derived parent/children, no passphrase in mounted data.
// Needs rig/start.sh running (rig/.run/env present). Stock->AD4M is the slow
// gossip direction on a cold 2-node net (step-0 notes), so polls bound at
// 300s like B1, not the brief's 60s.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as ad4m from "../ad4m.mjs";
import { rigEnv, REPO_DIR } from "../envfile.mjs";
import * as stock from "../stock.mjs";

const env = rigEnv();
const BASE_BUNDLE = join(REPO_DIR, "language", "build", "bundle.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

assert.ok(
  env.SEED && env.STOCK_DNA && env.STOCK_AGENT && env.AD4M_DATA,
  "rig/.run/env missing or incomplete — start rig/start.sh first"
);

let S = null; // stock connection {adminWs, app, cid, agent, dna}
let L = null; // language address
let uuid = null; // perspective uuid
let A = null; // outcome A actionHash (b64)
let B = null; // outcome B actionHash
let T = null; // tag actionHash

const url = (h) => `${L}://${h}`;

// perspective.modelQuery params are snake_case on the wire (the generated
// contract names them class_name / query_json — PerspectiveModelQueryParams).
async function modelQuery(className, queryJson = "{}") {
  const res = await ad4m.rpc(
    "perspective.modelQuery",
    { uuid, class_name: className, query_json: queryJson },
    180000
  );
  const parsed = typeof res === "string" ? JSON.parse(res) : res;
  return parsed?.instances ?? [];
}

// Poll a modelQuery until `accept(rows)` holds; returns the rows.
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

test("stock creates outcome A, B under A, tag T on A, comment on A", async (t) => {
  S = await stock.connect();
  const recA = await stock.createOutcome(S, "outcome A — from stock");
  A = recA.actionHash;
  B = (await stock.createOutcomeUnder(S, A, "outcome B — child of A")).actionHash;
  T = (await stock.createTag(S, "rig tag")).actionHash;
  // update needs the full new entry: A's entry with tags=[T]. The actionHash
  // in the update input is the create hash — the record address stays A.
  await stock.updateOutcome(S, A, { ...recA.entry, tags: [T], timestampUpdated: Date.now() });
  await stock.createComment(S, A, "a comment on A");
  t.diagnostic(`A=${A} B=${B} T=${T}`);
});

test("mount exposes the stock records through modelQuery", async (t) => {
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

  // loads + inits the language (cell registered, seed applied)
  const info = await ad4m.waitForInfo(`${L}://project`, 180000);
  assert.equal(info.dnaHash, env.STOCK_DNA);

  const handle = await ad4m.rpc("perspective.create", { name: "b2 mount" });
  uuid = handle.uuid;
  assert.ok(uuid, `perspective.create returned ${JSON.stringify(handle)}`);

  // mount: shapes + first sync. The language cell is up (waitForInfo), so a
  // failure here is real; retry once anyway — the resync loop would too.
  try {
    await ad4m.rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
  } catch (e) {
    await sleep(5000);
    await ad4m.rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
  }

  // A and B must arrive through stock->AD4M gossip + the 15s mount resync.
  const t1 = Date.now();
  const rows = await untilRows(
    "AcornOutcome",
    (r) => r.some((o) => o.id === url(A)) && r.some((o) => o.id === url(B)),
    300000,
    "AcornOutcome did not show A and B"
  );
  t.diagnostic(`A and B visible after ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  const a = rows.find((o) => o.id === url(A));
  const b = rows.find((o) => o.id === url(B));
  assert.equal(a.content, "outcome A — from stock");
  assert.deepEqual(a.tags, [url(T)]);
  assert.ok(Array.isArray(a.children) && a.children.includes(url(B)), `A.children=${JSON.stringify(a.children)}`);
  assert.equal(b.parent, url(A));
  assert.equal(b.content, "outcome B — child of A");
});

test("AcornOutcomeComment shows the comment with outcome = L://<A>", async (t) => {
  const rows = await untilRows(
    "AcornOutcomeComment",
    (r) => r.some((c) => c.outcome === url(A) && c.content === "a comment on A"),
    300000,
    "comment not visible"
  );
  const c = rows.find((x) => x.outcome === url(A));
  assert.ok(c);
  assert.match(c.creator, /^did:key:z6Mk/);
});

test("AcornProjectMeta mounts without the passphrase", async (t) => {
  const rows = await untilRows(
    "AcornProjectMeta",
    (r) => r.length >= 1,
    300000,
    "project meta not visible"
  );
  for (const row of rows) {
    assert.ok(!("passphrase" in row), `passphrase leaked: ${JSON.stringify(row)}`);
    assert.equal(row.name, "Rig Project");
  }

  const res = await ad4m.rpc("perspective.querySparql", {
    uuid,
    query: "SELECT ?s ?o WHERE { ?s <acorn://passphrase> ?o }",
  });
  const parsed = typeof res === "string" ? JSON.parse(res) : res;
  const bindings = parsed?.results?.bindings ?? [];
  assert.equal(bindings.length, 0, `passphrase triples present: ${JSON.stringify(bindings)}`);
  assert.ok(
    !JSON.stringify(parsed).includes("acorn://passphrase"),
    `acorn://passphrase leaked into the store: ${JSON.stringify(parsed)}`
  );
});

test("syncMount over 500 stock outcomes — timed (R6, no assertion)", async (t) => {
  const N = 500;
  const t0 = Date.now();
  await stock.createOutcomes(S, N, "perf outcome");
  t.diagnostic(`500 stock creates took ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // wait until gossip+resync make them visible (bounded; record the count)
  const t1 = Date.now();
  let rows = [];
  try {
    rows = await untilRows(
      "AcornOutcome",
      (r) => r.length >= N + 2,
      240000,
      "perf outcomes"
    );
  } catch {
    rows = await modelQuery("AcornOutcome");
  }
  const seen = rows.length;
  t.diagnostic(`${seen}/${N + 2} outcomes visible after ${((Date.now() - t1) / 1000).toFixed(1)}s of gossip`);

  const s0 = Date.now();
  const report = await ad4m.rpc(
    "perspective.syncMount",
    { uuid, languageAddress: L },
    600000
  );
  const ms = Date.now() - s0;
  t.diagnostic(`syncMount over ~${seen} outcomes: ${ms}ms — report ${JSON.stringify(report)}`);

  // The resync loop may already have ingested them (report added:0). A
  // remount times the full ingest: unmount drops the Local record links,
  // mount's first sync writes every record in one pass.
  await ad4m.rpc("perspective.unmount", { uuid, languageAddress: L });
  const m0 = Date.now();
  await ad4m.rpc("perspective.mount", { uuid, languageAddress: L }, 600000);
  t.diagnostic(`mount over ~${seen} outcomes (full ingest): ${Date.now() - m0}ms`);
});

test.after(async () => {
  if (S) await stock.closeStock(S);
  ad4m.close();
});
