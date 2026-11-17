// B4 rig tests — a stock-side change must reach the AD4M mount through the
// Acorn remote signal -> mountDelta push path, not gossip + the 15 s resync
// (stock->AD4M DHT visibility can take minutes or never arrive — step 0).
// Every fixture record is therefore created AFTER the mount: its own create
// signal is what lands it in the mount, and the polls that await it would
// take far longer than the push needs if the signal path were broken.
//
//   1. stock creates + renames an outcome -> perspective.modelSubscribe on
//      AcornOutcome delivers the new content in under 3 s (resync is 15 s,
//      so a pass proves the push worked). Prints `push latency: <n> ms`.
//   2. stock delete_outcome_fully on an outcome with a connection and a
//      comment -> within 20 s modelQuery no longer has any of the three,
//      without a syncMount. The child outcome survives (the zome call only
//      deletes connections that touch the deleted outcome).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as ad4m from "../ad4m.mjs";
import { rigEnv, REPO_DIR } from "../envfile.mjs";
import * as stock from "../stock.mjs";

const env = rigEnv();
const BASE_BUNDLE = join(REPO_DIR, "language", "build", "bundle.js");
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

test("stock outcome create+rename pushes a modelSubscribe update before the resync", async (t) => {
  const subscriptionId = `b4-${NONCE}`;
  const sub = await ad4m.rpc("perspective.modelSubscribe", {
    uuid,
    class_name: "AcornOutcome",
    query_json: "{}",
    subscriptionId,
  });
  t.diagnostic(`subscription opened at revision ${sub?.revision}`);

  // create lands through the same push path — fixture plus its own proof.
  // (url(R) matches once R is set: accept runs per frame, not per call.)
  const created = waitForUpdate(
    subscriptionId,
    (row) => rowId(row) === url(R),
    30000,
    "create pushes the new outcome"
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
    20000,
    "rename pushes the updated outcome"
  );
  const t0 = Date.now();
  await stock.updateOutcome(S, R, { ...R_ENTRY, content: NEWNAME });
  await renamed;
  const latency = Date.now() - t0;
  console.log(`push latency: ${latency} ms`);
  // B6: a signal is only an invalidation hint — the push waits for the
  // update op to gossip in and verify through the zomes, so the bound is
  // "before the ~15 s resync", not the old payload-trusted ~1 s.
  assert.ok(
    latency < 14000,
    `push took ${latency}ms — did not beat the ~15 s resync`
  );
});

test("stock delete_outcome_fully removes outcome, connection and comment", async (t) => {
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

  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 20000) {
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
      t.diagnostic(`mount lost D/conn/comment ${Date.now() - t0}ms after delete`);
      break;
    }
    await sleep(1000);
  }
  assert.ok(!last.outcomes.some((o) => o.id === url(D)), "D still in AcornOutcome query");
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
