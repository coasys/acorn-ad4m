// One-off raw-signal capture for B4 (design R11): mount the language, wait
// until the stock conductor sees our member (signals go to the members the
// SENDER's local store lists), have stock create one outcome, then leave the
// ACORN_RAW_SIGNAL line in .run/executor.log for the fixture file.
import { join } from "node:path";
import * as ad4m from "./ad4m.mjs";
import { rigEnv, REPO_DIR } from "./envfile.mjs";
import * as stock from "./stock.mjs";

const env = rigEnv();
const BASE_BUNDLE = join(REPO_DIR, "language", "build", "bundle.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = await stock.connect();
const base = ad4m.publishLocal(BASE_BUNDLE, { name: "acorn" });
const ref = await ad4m.applyTemplateLocal(base, { seed: env.SEED });
const L = ref.address;
const info = await ad4m.waitForInfo(`${L}://project`, 180000);
console.log("lang", L, "agent", info.agentPubKey, "dna", info.dnaHash);

const handle = await ad4m.rpc("perspective.create", { name: "b4 capture" });
const uuid = handle.uuid;
try {
  await ad4m.rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
} catch (e) {
  await sleep(5000);
  await ad4m.rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
}
console.log("mounted");

// stock's get_peers must list our agent before its sends reach us
let seen = false;
for (let i = 0; i < 90 && !seen; i++) {
  const members = await stock.stockCall(S, "projects", "fetch_members", {
    input: null,
    local: true,
  });
  seen = members.some((m) => m.entry.agentPubKey === info.agentPubKey);
  if (!seen) await sleep(2000);
}
console.log("stock sees our member:", seen);

const rec = await stock.createOutcome(S, `b4 raw signal ${Date.now()}`);
console.log("stock created outcome", rec.actionHash);
await sleep(5000);
await stock.closeStock(S);
ad4m.close();
