import test from "node:test";
import assert from "node:assert/strict";
import { agentToDid } from "../../src/agent";
import { deriveRelations, toData, type MapCtx } from "../../src/mapping";

const LANG = "QmzLangTest";
const OUTCOME_A = "uhCkkb3V0Y29tZUEuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
const OUTCOME_B = "uhCkkb3V0Y29tZUIuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
const OUTCOME_C = "uhCkkb3V0Y29tZUMuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";

function conn(parent: string, child: string, actionHash: string) {
  return {
    actionHash,
    entryHash: "uhCkkZW50cnkLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh",
    entry: {
      parentActionHash: parent,
      childActionHash: child,
      siblingOrder: 0,
      randomizer: 1,
      isImported: false,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function outcome(actionHash: string) {
  return {
    actionHash,
    entryHash: "uhCkkZW50cnkLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh",
    entry: {
      content: `outcome ${actionHash.slice(-4)}`,
      creatorAgentPubKey: "uhCAkDsZGYpTXiihwf8CcfsbpLcyzmP_jMWv28biNaAknxgUudQnS",
      editorAgentPubKey: null,
      timestampCreated: 1,
      timestampUpdated: null,
      scope: { Small: { achievementStatus: "NotAchieved", targetDate: null, taskList: [] } },
      tags: [],
      description: "",
      isImported: false,
      githubLink: "",
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

test("two connections set parent and children on three outcomes", () => {
  // A is the parent of B and C (A <- B, A <- C)
  const derived = deriveRelations([
    conn(OUTCOME_A, OUTCOME_B, "uhCkkY29ubkFCLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh"),
    conn(OUTCOME_A, OUTCOME_C, "uhCkkY29ubkFDLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh"),
  ]);
  const ctx: MapCtx = {
    lang: LANG,
    hashToUrl: (h) => `${LANG}://${h}`,
    agentToDid,
    derived,
  };
  const a = toData("AcornOutcome", outcome(OUTCOME_A), ctx);
  const b = toData("AcornOutcome", outcome(OUTCOME_B), ctx);
  const c = toData("AcornOutcome", outcome(OUTCOME_C), ctx);

  assert.deepEqual(a.children, [`${LANG}://${OUTCOME_B}`, `${LANG}://${OUTCOME_C}`]);
  assert.ok(!("parent" in a));
  assert.equal(b.parent, `${LANG}://${OUTCOME_A}`);
  assert.ok(!("children" in b));
  assert.equal(c.parent, `${LANG}://${OUTCOME_A}`);
  assert.ok(!("children" in c));
});

test("an outcome with no connection has neither key", () => {
  const derived = deriveRelations([
    conn(OUTCOME_A, OUTCOME_B, "uhCkkY29ubkFCLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh"),
  ]);
  const ctx: MapCtx = {
    lang: LANG,
    hashToUrl: (h) => `${LANG}://${h}`,
    agentToDid,
    derived,
  };
  const c = toData("AcornOutcome", outcome(OUTCOME_C), ctx);
  assert.ok(!("parent" in c));
  assert.ok(!("children" in c));
});

test("a childless tree with zero connections derives nothing", () => {
  const derived = deriveRelations([]);
  assert.equal(derived.parents.size, 0);
  assert.equal(derived.children.size, 0);
});
