// B4 rig tests — a stock-side change must reach the AD4M mount through the
// Acorn remote signal -> mountDelta push path. Every fixture record is
// created AFTER the mount: its own create signal is what lands it.
//
// B7 (Lal round 2, #5): a latency bound alone cannot prove push — the
// executor's 15 s periodic resync (fixed in the binary) delivers the same
// change, and its next tick can fall anywhere in the window. So:
//
//   1. PUSH, resync OFF. The language's periodic resync is switched off
//      (`mountResync` project interaction: every mountSnapshot after the
//      first answers the mount as the signal worker left it, without
//      reading). Stock creates + renames an outcome -> modelSubscribe
//      delivers both. With nothing else feeding the mount, arrival at all
//      proves the push path; the bound is the worker's verification budget
//      (13 s wall clock per record) plus slack. Prints `push latency`.
//   2. RECOVERY, resync ON. A signal hint never removes (B7 P1: no stock
//      read proves a deletion), so stock delete_outcome_fully reaches the
//      mount only through the periodic resync: modelQuery loses outcome,
//      connection and comment once two complete resync reads >= 15 s
//      apart have missed them (B8, F1) — bound 45 s, no syncMount. The child outcome survives. Prints the recovery latency.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as ad4m from "../ad4m.mjs";
import { rigEnv, REPO_DIR } from "../envfile.mjs";
import * as stock from "../stock.mjs";

const env = rigEnv();
const BASE_BUNDLE =
  process.env.ACORN_BUNDLE ?? join(REPO_DIR, "language", "build", "bundle.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NONCE = Date.now().toString(36);

assert.ok(
  env.SEED && env.STOCK_DNA && env.STOCK_AGENT && env.AD4M_DATA,
  "rig/.run/env missing or incomplete — start rig/start.sh first"
);

let S = null; // stock connection {adminWs, app, cid, agent, dna}
let L = null; // language address
let uuid = null; // perspective uuid
let R = null; // rename target outcome actionHash
let R_ENTRY = null; // its entry (for update_outcome)
let D = null; // delete target outcome actionHash
let D_CHILD = null; // child outcome (must survive the delete)
let D_CONN = null; // connection actionHash D -> D_CHILD
let D_COMMENT = null; // comment actionHash on D

const url = (h) => `${L}://${h}`;

async function modelQuery(className) {
  const res = await ad4m.rpc(
    "perspective.modelQuery",
    { uuid, class_name: className, query_json: "{}" },
    180000
  );
  const parsed = typeof res === "string" ? JSON.parse(res) : res;
  return parsed?.instances ?? parsed ?? [];
}

// Poll modelQuery until `accept(rows)` is truthy; returns the rows.
async function untilRows(className, accept, timeoutMs, what) {
  const t0 = Date.now();
  let rows = [];
  while (Date.now() - t0 < timeoutMs) {
    rows = await modelQuery(className);
    if (accept(rows)) return rows;
    await sleep(500);
  }
  throw new Error(
    `${what}: not satisfied after ${timeoutMs}ms; last rows: ` +
      JSON.stringify(rows).slice(0, 600)
  );
}

// `query-subscription-update` frames carry model results as `ids` +
// `upsert` rows (types/domain.rs QuerySubscriptionUpdate). A whole-result
// refresh arrives as `result` — same {instances} shape modelQuery returns.
function updateRows(frame) {
  return [...(frame?.upsert ?? []), ...(frame?.result?.instances ?? [])];
}

const rowId = (r) => r?.id ?? r?.instance?.id ?? (Array.isArray(r) ? r[0] : null);
const rowField = (r, name) =>
  r?.[name] ?? r?.data?.[name] ?? (Array.isArray(r) ? r[1]?.[name] : null);

// Wait for a subscription update carrying a row `accept` matches; resolves
// {row, at}. Captures frames for the failure diagnostic. Register BEFORE
// the triggering call — the push lands in about a second.
function waitForUpdate(subscriptionId, accept, timeoutMs, what) {
  const seen = [];
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setTimeout(() => {
      off();
      reject(
        new Error(
          `${what}: no matching update after ${timeoutMs}ms; saw ` +
            `${seen.length} frames: ${seen
              .map((f) => JSON.stringify(f).slice(0, 400))
              .join(" | ")}`
        )
      );
    }, timeoutMs);
    const off = ad4m.onEvent((msg) => {
      if (msg?.type !== "query-subscription-update") return;
      if (msg.subscriptionId !== subscriptionId) return;
      if (msg.lagged) return;
      seen.push(msg);
      for (const row of updateRows(msg)) {
        if (accept(row)) {
          clearTimeout(timer);
          off();
          resolve({ row, at: Date.now(), elapsed: Date.now() - t0 });
          return;
        }
      }
    });
  });
}

test("setup: mount the language on a fresh perspective", async (t) => {
  S = await stock.connect();
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

  const handle = await ad4m.rpc("perspective.create", { name: "b4 mount" });
  uuid = handle.uuid;
  try {
    await ad4m.rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
  } catch (e) {
    await sleep(5000);
    await ad4m.rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
  }
  t.diagnostic(`mounted ${L} on ${uuid}`);
});

// Push precondition: Acorn's get_peers (projects/src/lib.rs:190) lists
// the signal recipients from the sender's LOCAL member links, so the stock
// agent signals the AD4M agent only once the AD4M member entry has gossiped
// to the stock side. A signal sent before that is never delivered (the
// "first-signal warmup" of REPORT-b4, deviation 5) — with the resync off
// the record would never land. Wait for the precondition, then measure.
test("warmup: the stock side lists the AD4M agent as a peer", async (t) => {
  const info = await ad4m.interact(`${L}://project`, "info", {});
  const t0 = Date.now();
  let seen = false;
  while (!seen && Date.now() - t0 < 300000) {
    const rows = await stock.stockCall(S, "projects", "fetch_members", {
      input: null,
      local: true,
    });
    seen = (rows ?? []).some((m) => (m?.entry ?? m)?.agentPubKey === info.agentPubKey);
    if (!seen) await sleep(1000);
  }
  assert.ok(seen, `stock never listed the AD4M member ${info.agentPubKey} within 300 s`);
  t.diagnostic(`AD4M member visible to stock after ${Date.now() - t0} ms`);
});

// mountResync exists only in a TEST build (Lal round 3, F5):
//   cd language && ACORN_TEST_BUILD=1 node build.mjs
async function setResync(enabled) {
  let res;
  try {
    res = await ad4m.interact(`${L}://project`, "mountResync", { enabled });
  } catch (e) {
    throw new Error(
      `mountResync unavailable — b4 needs a test build (ACORN_TEST_BUILD=1 node build.mjs): ${e.message}`
    );
  }
  assert.deepEqual(res, { enabled }, `mountResync(${enabled}) answered ${JSON.stringify(res)}`);
}

test("resync OFF: stock outcome create+rename reach modelSubscribe by push alone", async (t) => {
  await setResync(false);
  const subscriptionId = `b4-${NONCE}`;
  const sub = await ad4m.rpc("perspective.modelSubscribe", {
    uuid,
    class_name: "AcornOutcome",
    query_json: "{}",
    subscriptionId,
  });
  t.diagnostic(`subscription opened at revision ${sub?.revision}`);

  // create lands through the push path — fixture plus its own proof.
  // (url(R) matches once R is set: accept runs per frame, not per call.)
  const created = waitForUpdate(
    subscriptionId,
    (row) => rowId(row) === url(R),
    20000,
    "create pushes the new outcome (resync off)"
  );
  const rec = await stock.createOutcome(S, `b4 rename ${NONCE}`);
  R = rec.actionHash;
  R_ENTRY = rec.entry;
  const { elapsed: createMs } = await created;
  t.diagnostic(`create signal -> subscription: ${createMs}ms`);

  const NEWNAME = `b4 renamed ${NONCE}`;
  const renamed = waitForUpdate(
    subscriptionId,
    (row) => rowId(row) === url(R) && rowField(row, "content") === NEWNAME,
    30000,
    "rename pushes the updated outcome (resync off)"
  );
  const t0 = Date.now();
  await stock.updateOutcome(S, R, { ...R_ENTRY, content: NEWNAME });
  await renamed;
  const latency = Date.now() - t0;
  console.log(`push latency: ${latency} ms`);
  // resync is off: arrival itself proves the push. The bound is the
  // worker's per-record verification budget (13 s) + a pass + slack.
  assert.ok(latency < 16000, `push took ${latency}ms — over the 13 s verify budget`);
});

test("resync ON: stock delete_outcome_fully is recovered by the periodic resync", async (t) => {
  await setResync(true);
  // fixture records — each create lands in the mount through its own signal
  const d = await stock.createOutcome(S, `b4 delete ${NONCE}`);
  D = d.actionHash;
  await untilRows("AcornOutcome", (r) => r.some((o) => o.id === url(D)), 30000, "D pushed to mount");

  const cwr = await stock.stockCall(S, "projects", "create_outcome_with_connection", {
    entry: stock.outcomeEntry(S.agent, `b4 child ${NONCE}`),
    maybeLinkedOutcome: {
      outcomeActionHash: D,
      relation: "ExistingOutcomeAsParent",
      siblingOrder: 0,
    },
  });
  D_CHILD = cwr.outcome.actionHash;
  D_CONN = cwr.maybeConnection.actionHash;
  await untilRows(
    "AcornConnection",
    (r) => r.some((c) => c.id === url(D_CONN)),
    30000,
    "D->child connection pushed to mount"
  );

  const cm = await stock.createComment(S, D, `b4 comment ${NONCE}`);
  D_COMMENT = cm.actionHash;
  await untilRows(
    "AcornOutcomeComment",
    (r) => r.some((c) => c.id === url(D_COMMENT)),
    30000,
    "comment pushed to mount"
  );
  t.diagnostic(`D=${D} conn=${D_CONN} comment=${D_COMMENT} child=${D_CHILD}`);

  const res = await stock.stockCall(S, "projects", "delete_outcome_fully", {
    input: D,
    local: true,
  });
  t.diagnostic(`delete_outcome_fully -> ${JSON.stringify(res).slice(0, 400)}`);

  // B8 (Lal round 3, F1): removal needs two complete absent resync reads
  // started >= 15 s apart — up to one interval until the first, one more
  // until the second, plus the reads + slack
  const RECOVERY_MS = 45000;
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < RECOVERY_MS) {
    const [outcomes, conns, comments] = await Promise.all([
      modelQuery("AcornOutcome"),
      modelQuery("AcornConnection"),
      modelQuery("AcornOutcomeComment"),
    ]);
    last = { outcomes, conns, comments };
    const gone =
      !outcomes.some((o) => o.id === url(D)) &&
      !conns.some((c) => c.id === url(D_CONN)) &&
      !comments.some((c) => c.id === url(D_COMMENT));
    if (gone) {
      console.log(`recovery latency: ${Date.now() - t0} ms`);
      break;
    }
    await sleep(1000);
  }
  assert.ok(
    !last.outcomes.some((o) => o.id === url(D)),
    `D still in AcornOutcome query after ${RECOVERY_MS} ms`
  );
  assert.ok(
    !last.conns.some((c) => c.id === url(D_CONN)),
    "connection still in AcornConnection query"
  );
  assert.ok(
    !last.comments.some((c) => c.id === url(D_COMMENT)),
    "comment still in AcornOutcomeComment query"
  );
  // the child outcome itself is not deleted by delete_outcome_fully
  assert.ok(
    last.outcomes.some((o) => o.id === url(D_CHILD)),
    "child outcome should survive delete_outcome_fully"
  );
});

test.after(async () => {
  if (S) await stock.closeStock(S);
  ad4m.close();
});
