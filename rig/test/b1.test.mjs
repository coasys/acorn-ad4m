// B1 rig tests — needs rig/start.sh running (rig/.run/env present) and a
// DEBUG build of the language (ACORN_DEBUG_CALL=1 node build.mjs) for the
// zome-call test.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as ad4m from "../ad4m.mjs";
import { rigEnv, REPO_DIR } from "../envfile.mjs";

const env = rigEnv();
const BASE_BUNDLE = join(REPO_DIR, "language", "build", "bundle.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let base = null;
let L = null;
let L2 = null;

assert.ok(
  env.SEED && env.STOCK_DNA && env.AD4M_DATA,
  "rig/.run/env missing or incomplete — start rig/start.sh first"
);

test("same seed gives the stock DNA hash", async (t) => {
  base = ad4m.publishLocal(BASE_BUNDLE, { name: "acorn" });
  // the conductor comes up lazily after agent.generate — retry the
  // templating until installApp can reach it
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
  assert.ok(L.startsWith("Qmz"), `unexpected address ${L}`);

  const info = await ad4m.waitForInfo(`${L}://project`, 120000);
  assert.equal(info.seed, env.SEED);
  assert.equal(info.dnaHash, env.STOCK_DNA);
  assert.ok(info.agentPubKey?.startsWith("uhCAk"), info.agentPubKey);
  assert.deepEqual(info.cellId, [env.STOCK_DNA, info.agentPubKey]);
  assert.ok(info.ad4mDid, "ad4mDid should be set");
  assert.equal(info.agentDid, null); // B5 fills this
});

test("another seed gives another DNA hash", async (t) => {
  const ref = await ad4m.applyTemplateLocal(base, { seed: "uid-other" });
  L2 = ref.address;
  assert.notEqual(L2, L);
  const info = await ad4m.waitForInfo(`${L2}://project`, 120000);
  assert.equal(info.seed, "uid-other");
  assert.notEqual(info.dnaHash, env.STOCK_DNA);
});

test("the seed is not published", async (t) => {
  // language.meta resolves through the language language — the templated
  // language was never published, so this must fail, or return a meta
  // whose templateAppliedParams does not contain the seed.
  let meta = null;
  try {
    meta = await ad4m.rpc("language.meta", { address: L });
  } catch {
    return; // not published at all — pass
  }
  const hay = JSON.stringify(meta?.templateAppliedParams ?? "");
  assert.ok(
    !hay.includes(env.SEED),
    `templateAppliedParams leaks the seed: ${hay}`
  );
});

test("a zome call works (debug build)", async (t) => {
  const info = await ad4m.interact(`${L}://project`, "info", {});
  // B->A is the slow gossip direction on a cold 2-node network (step-0
  // notes): the stock member must reach AD4M's DHT before fetch_members
  // shows it. AD4M's own member appears on the first call (cell init).
  const t0 = Date.now();
  let found = null;
  while (Date.now() - t0 < 300000) {
    const res = await ad4m.interact(`${L}://project`, "call", {
      zome: "projects",
      fn: "fetch_members",
      payload: { input: null, local: false },
    });
    const members = (res || [])
      .map((m) => {
        const k = m?.entry?.agentPubKey;
        return typeof k === "string" ? k : k?.__hash;
      })
      .filter(Boolean);
    const want = new Set([env.STOCK_AGENT, info.agentPubKey]);
    if ([...want].every((a) => members.includes(a))) {
      found = members;
      break;
    }
    await sleep(2000);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  assert.ok(
    found,
    `fetch_members did not show both agents within 300s (stock=${env.STOCK_AGENT}, ad4m=${info.agentPubKey})`
  );
  t.diagnostic(`both members visible after ${elapsed}s`);
});

test.after(() => ad4m.close());
