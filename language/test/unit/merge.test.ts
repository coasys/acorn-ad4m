// B3 update merge: mergeForUpdate(currentEntry, params) must change only the
// supplied writable properties and rebuild the entry from the merged data —
// most importantly the `scope` variant rebuild on a scopeType switch.
import test from "node:test";
import assert from "node:assert/strict";
import { agentToDid, didToAgent } from "../../src/agent";
import { mergeForUpdate, type MapCtx, type ToEntryCtx } from "../../src/mapping";
import * as F from "./fixtures";

const ctx: MapCtx & ToEntryCtx = {
  lang: F.LANG,
  hashToUrl: (h) => `${F.LANG}://${h}`,
  agentToDid,
  didToAgent,
  seed: F.SEED,
};

test("mergeForUpdate changes only the named field", () => {
  const cur = F.smallOutcomeEntry();
  const e = mergeForUpdate("AcornOutcome", cur, { content: "new" }, ctx);
  assert.deepEqual(e, { ...cur, content: "new" });
});

test("{ scopeType: 'Small' } on an Uncertain outcome gives a Small scope with defaults", () => {
  const cur = F.uncertainOutcomeEntry();
  const e = mergeForUpdate("AcornOutcome", cur, { scopeType: "Small" }, ctx);
  assert.deepEqual(e.scope, {
    Small: { achievementStatus: "NotAchieved", targetDate: null, taskList: [] },
  });
  // everything outside scope stays identical
  const { scope: _s1, ...rest } = e as Record<string, unknown>;
  const { scope: _s2, ...expected } = cur as Record<string, unknown>;
  assert.deepEqual(rest, expected);
});

test("Small fields merge into the existing Small scope", () => {
  const cur = F.smallOutcomeEntry();
  const e = mergeForUpdate("AcornOutcome", cur, { achievementStatus: "Achieved" }, ctx);
  assert.deepEqual(e.scope, {
    Small: { ...cur.scope.Small, achievementStatus: "Achieved" },
  });
});

test("ref params map URLs back to hashes; did:key agents to AgentPubKeyB64", () => {
  const cur = F.smallOutcomeEntry();
  const e = mergeForUpdate(
    "AcornOutcome",
    cur,
    { tags: [`${F.LANG}://${F.TAG_T}`, `${F.LANG}://${F.CONNECTION_AB}`] },
    ctx
  );
  assert.deepEqual(e.tags, [F.TAG_T, F.CONNECTION_AB]);
});

test("params cannot touch read-only fields", () => {
  const cur = F.smallOutcomeEntry();
  const e = mergeForUpdate(
    "AcornOutcome",
    cur,
    {
      isImported: true,
      creator: agentToDid(F.AGENT_B),
      timestampCreated: 1,
      entryHash: "uhCkkbogus",
      parent: `${F.LANG}://${F.OUTCOME_B}`,
      children: [`${F.LANG}://${F.OUTCOME_B}`],
    },
    ctx
  );
  assert.deepEqual(e, cur);
});

test("taskList/timeFrame accept the mounted JSON-string form", () => {
  const cur = F.smallOutcomeEntry();
  const e = mergeForUpdate(
    "AcornOutcome",
    cur,
    { taskList: JSON.stringify([{ complete: true, task: "x" }]) },
    ctx
  );
  assert.deepEqual(e.scope.Small.taskList, [{ complete: true, task: "x" }]);
});
