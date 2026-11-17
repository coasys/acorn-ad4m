// B3 rig tests — AD4M writes through the mount become Acorn zome calls a
// stock conductor sees. Every write goes through the executor's
// perspective.createSubject / updateSubject / removeSubject; the stock side
// is checked with its own fetch_* on the stock cell. AD4M->stock gossip was
// measured under a second in step 0; polls bound at 30 s.
//
// Fields the Acorn UI stamps on every outcome update — editorAgentPubKey
// (the active agent) and timestampUpdated (moment().unix()) — are also set
// by the language's update path, so the full-entry equality checks exclude
// exactly those two, same as a UI-driven compare would.
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
let P = null; // outcome P actionHash (b64)
let C = null; // outcome C actionHash
let T = null; // tag actionHash
let COMMENT = null; // comment actionHash

const url = (h) => `${L}://${h}`;

// ---- executor-side write helpers -----------------------------------------

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
  // a call constructor returns the new record's URL, not `true`
  assert.equal(typeof res, "string", `createSubject ${className} returned ${JSON.stringify(res)}`);
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

function removeSubject(className, address) {
  return ad4m.rpc(
    "perspective.removeSubject",
    {
      uuid,
      subjectClass: className,
      expressionAddress: url(address),
    },
    120000
  );
}

// ---- stock-side reads -----------------------------------------------------

const fetchAll = (fn) =>
  stock.stockCall(S, "projects", fn, { input: { All: null }, local: true });
const outcomes = () => fetchAll("fetch_outcomes");
const connections = () => fetchAll("fetch_connections");
const comments = () => fetchAll("fetch_outcome_comments");
const tags = () => fetchAll("fetch_tags");

// Poll until `accept(read())` is truthy. Returns the accept value when it is
// a found object, the raw read when accept is a boolean predicate.
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

const findRecord = async (fn, actionHash) =>
  (await fn()).find((r) => r.actionHash === actionHash);

async function modelQuery(className) {
  const res = await ad4m.rpc(
    "perspective.modelQuery",
    { uuid, class_name: className, query_json: "{}" },
    180000
  );
  const parsed = typeof res === "string" ? JSON.parse(res) : res;
  return parsed?.instances ?? [];
}

// ---- tests ----------------------------------------------------------------

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

  const handle = await ad4m.rpc("perspective.create", { name: "b3 mount" });
  uuid = handle.uuid;
  try {
    await ad4m.rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
  } catch (e) {
    await sleep(5000);
    await ad4m.rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
  }
  t.diagnostic(`mounted ${L} on ${uuid}`);
});

test("createSubject AcornOutcome {content:'P'} returns a URL stock sees", async (t) => {
  const pUrl = await createSubject("AcornOutcome", { content: "P" });
  P = pUrl.slice(`${L}://`.length);
  assert.ok(P.startsWith("uh"), `P address ${P}`);
  const rec = await until(
    () => findRecord(outcomes, P),
    (r) => r != null,
    30000,
    "stock fetch_outcomes has P"
  );
  assert.equal(rec.entry.content, "P");
  assert.equal(rec.entry.creatorAgentPubKey.length > 0, true);
  t.diagnostic(`P=${P}`);
});

test("createSubject child C with parent:<P url> writes the P->C connection", async () => {
  const cUrl = await createSubject("AcornOutcome", { content: "C", parent: url(P) });
  C = cUrl.slice(`${L}://`.length);
  const conn = await until(
    connections,
    (rows) => rows.find((r) => r.entry.parentActionHash === P && r.entry.childActionHash === C),
    30000,
    "stock fetch_connections has P->C"
  );
  assert.equal(conn.entry.parentActionHash, P);
  assert.equal(conn.entry.childActionHash, C);
});

test("updateSubject C {content:'C2'} changes only content (+ UI stamp fields)", async () => {
  const before = (await findRecord(outcomes, C)).entry;
  await updateSubject("AcornOutcome", C, { content: "C2" });
  const rec = await until(
    () => findRecord(outcomes, C),
    (r) => r?.entry.content === "C2",
    30000,
    "stock outcome C renamed to C2"
  );
  const after = rec.entry;
  // content is the field under test; editorAgentPubKey/timestampUpdated are
  // the UI's per-update stamp the language also sets. Everything else must
  // be byte-identical to the entry before the update.
  assert.equal(after.content, "C2");
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
  assert.equal(after.editorAgentPubKey.length > 0, true);
  assert.equal(typeof after.timestampUpdated, "number");
});

test("updateSubject C {scopeType:'Small', achievementStatus:'Achieved'} rebuilds scope", async () => {
  // the fixture C was created Uncertain (the create default); this update
  // flips it to a Small scope the UI would show as achieved.
  await updateSubject("AcornOutcome", C, {
    scopeType: "Small",
    achievementStatus: "Achieved",
  });
  const scope = await until(
    () => findRecord(outcomes, C).then((r) => r?.entry.scope),
    (s) => s?.Small?.achievementStatus === "Achieved",
    30000,
    "stock C scope is Small/Achieved"
  );
  assert.deepEqual(scope.Small.achievementStatus, "Achieved");
  assert.equal(scope.Uncertain ?? null, null);
});

test("createSubject AcornTag + updateSubject C {tags:[T url]}", async () => {
  // hdk_crud links path->entry_hash and fetch_all resolves get_latest per
  // ENTRY, so a byte-identical tag from an earlier run would dedup onto the
  // old entry and fetch_tags would report the old action, not ours. A nonce
  // keeps the entry unique across repeated runs against the same DNA.
  const tUrl = await createSubject("AcornTag", {
    text: `rig tag ${Date.now()}`,
    backgroundColor: "#112233",
  });
  T = tUrl.slice(`${L}://`.length);
  await until(
    () => findRecord(tags, T),
    (r) => r != null,
    30000,
    "stock fetch_tags has T"
  );
  await updateSubject("AcornOutcome", C, { tags: [url(T)] });
  const rec = await until(
    () => findRecord(outcomes, C),
    (r) => JSON.stringify(r?.entry.tags) === JSON.stringify([T]),
    30000,
    "stock C.tags == [T]"
  );
  assert.deepEqual(rec.entry.tags, [T]);
});

test("createSubject AcornOutcomeComment on C", async () => {
  const cmUrl = await createSubject("AcornOutcomeComment", {
    outcome: url(C),
    content: `hi ${Date.now()}`,
  });
  COMMENT = cmUrl.slice(`${L}://`.length);
  const rec = await until(
    () => findRecord(comments, COMMENT),
    (r) => r != null,
    30000,
    "stock fetch_outcome_comments has the comment"
  );
  assert.equal(rec.entry.outcomeActionHash, C);
  assert.equal(rec.entry.content.startsWith("hi "), true);
});

test("removeSubject AcornOutcome C deletes C, P->C and the comment everywhere", async () => {
  await removeSubject("AcornOutcome", C);

  // stock side: outcome, connection and comment all gone
  await until(
    async () => ({
      outcome: await findRecord(outcomes, C),
      conn: (await connections()).find(
        (r) => r.entry.parentActionHash === P && r.entry.childActionHash === C
      ),
      comment: await findRecord(comments, COMMENT),
    }),
    (r) => !r.outcome && !r.conn && !r.comment,
    30000,
    "stock no longer contains C, P->C or the comment"
  );

  // AD4M side: gone from modelQuery without any syncMount — the delete
  // delta carried the complete `removed` list plus the changed parent.
  const outcomeRows = await modelQuery("AcornOutcome");
  assert.ok(!outcomeRows.some((o) => o.id === url(C)), "C still in AcornOutcome query");
  const connRows = await modelQuery("AcornConnection");
  assert.ok(
    !connRows.some((c) => c.child === url(C)),
    "P->C still in AcornConnection query"
  );
  const commentRows = await modelQuery("AcornOutcomeComment");
  assert.ok(
    !commentRows.some((c) => c.id === url(COMMENT)),
    "comment still in AcornOutcomeComment query"
  );
  // the parent lost its `children` edge
  const p = outcomeRows.find((o) => o.id === url(P));
  if (p) {
    assert.ok(
      !(Array.isArray(p.children) && p.children.includes(url(C))),
      `P.children still lists C: ${JSON.stringify(p.children)}`
    );
  }
});

test.after(async () => {
  if (S) await stock.closeStock(S);
  ad4m.close();
});
