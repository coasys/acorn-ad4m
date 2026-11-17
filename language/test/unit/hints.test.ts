// Lal round 3, F6: pin the first layer of the "a hint never removes"
// invariant directly. hintTargets(...) must be EMPTY for every deletion
// variant — CRUD deletes for each class, DeleteOutcomeFully, member and
// profile deletes, and malformed object-shaped payloads that look like
// records — and a burst of such hints must cost zero fetches and zero
// resyncs. (End-to-end null deltas alone did not pin this: a mutant that
// let `delete` through hintTargets survived the B7 suite.)
import test from "node:test";
import assert from "node:assert/strict";
import { hintTargets } from "../../src/signals";
import { Reconciler } from "../../src/reconcile";
import { MountState } from "../../src/state";
import { AGENT_A, LANG, OUTCOME_A, smallOutcomeEntry, wireRecord } from "./fixtures";

const CRUD = [
  ["Outcome", "outcome"],
  ["Connection", "connection"],
  ["EntryPoint", "entry_point"],
  ["OutcomeComment", "outcome_comment"],
  ["OutcomeMember", "outcome_member"],
  ["Tag", "tag"],
  ["ProjectMeta", "project_meta"],
  ["OutcomeVote", "outcome_vote"],
];

// every shape a deletion claim can take, well-formed or not
function deletionHints(): any[] {
  const rec = wireRecord(smallOutcomeEntry(), { actionHash: OUTCOME_A });
  const out: any[] = [];
  for (const [signalType, entryType] of CRUD) {
    for (const data of [
      OUTCOME_A, // the real wire shape: an ActionHashB64
      { actionHash: OUTCOME_A }, // object-shaped
      rec, // a whole WireRecord
      { ...rec, updatedAt: 9e15 },
      null,
      {},
    ]) {
      out.push({ signalType, data: { entryType, action: "delete", data } });
    }
  }
  out.push({
    signalType: "DeleteOutcomeFully",
    data: {
      entryType: "delete_outcome_fully",
      action: "delete",
      data: {
        outcomeActionHash: OUTCOME_A,
        actionHash: OUTCOME_A,
        deletedConnections: [OUTCOME_A],
        deletedOutcomeMembers: [],
        deletedOutcomeVotes: [],
        deletedOutcomeComments: [],
        deletedEntryPoints: [],
      },
    },
  });
  // DeleteOutcomeFully even with a create/update action is a deletion claim
  for (const action of ["create", "update"]) {
    out.push({
      signalType: "DeleteOutcomeFully",
      data: { entryType: "delete_outcome_fully", action, data: { outcomeActionHash: OUTCOME_A } },
    });
  }
  for (const key of ["entry_type", "entryType"]) {
    out.push({
      signalType: "Member",
      data: { [key]: "member", action: "delete", data: { agentPubKey: AGENT_A } },
    });
  }
  for (const data of [
    OUTCOME_A,
    { agentPubKey: AGENT_A },
    { entry: { agentPubKey: AGENT_A }, actionHash: OUTCOME_A },
  ]) {
    out.push({ signalType: "Agent", data: { entryType: "agent", action: "delete", data } });
  }
  // malformed object payloads
  out.push(
    { signalType: "Outcome", data: { action: "delete", data: { actionHash: OUTCOME_A } } },
    { signalType: "Outcome", data: { entryType: "outcome", action: "DELETE", data: rec } },
    { signalType: "Outcome", data: { entryType: "outcome", action: "remove", data: rec } },
    { signalType: "Outcome", data: { entryType: "outcome", action: ["delete"], data: rec } },
    { signalType: "Outcome", data: { entryType: "outcome", action: { delete: true }, data: rec } },
    { signalType: "Outcome", data: { entryType: "outcome", data: rec } }
  );
  return out;
}

test("hintTargets is empty for every deletion variant (F6)", () => {
  const hints = deletionHints();
  assert.ok(hints.length > 50);
  for (const h of hints) {
    assert.deepEqual(hintTargets(h), [], JSON.stringify(h).slice(0, 200));
  }
});

test("a deletion burst costs zero fetches, zero resyncs, zero pending (F6)", async () => {
  let fetches = 0;
  let resyncs = 0;
  const r = new Reconciler({
    lang: LANG,
    state: new MountState(),
    fetch: async () => {
      fetches++;
      return [];
    },
    emit: () => {},
    resync: async () => {
      resyncs++;
      return { changed: [], removed: [] };
    },
    maxPending: 4,
    budgetMs: 50,
    retryMs: 1,
  });
  r.start();
  for (let i = 0; i < 20; i++) for (const h of deletionHints()) r.hint(h);
  assert.equal(r.pending, 0);
  await r.idle();
  assert.equal(fetches, 0);
  assert.equal(resyncs, 0);
});
