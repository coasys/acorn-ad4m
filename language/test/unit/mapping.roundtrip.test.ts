// B3 round-trip: toEntry(toData(record)) must rebuild the original entry for
// every B2 fixture class. The one exception is AcornProjectMeta.passphrase —
// never mounted, so toEntry fills it from the language seed instead (the
// fixture uses the rig seed, which produces the same passphrase).
import test from "node:test";
import assert from "node:assert/strict";
import { agentToDid, didToAgent } from "../../src/agent";
import {
  toData,
  toEntry,
  seedToPassphrase,
  type MapCtx,
  type ToEntryCtx,
} from "../../src/mapping";
import * as F from "./fixtures";

const dataCtx: MapCtx = {
  lang: F.LANG,
  hashToUrl: (h) => `${F.LANG}://${h}`,
  agentToDid,
  // derived parent/children land in `data` and must be dropped by toEntry
  derived: {
    parents: new Map([[F.OUTCOME_B, F.OUTCOME_A]]),
    children: new Map([[F.OUTCOME_A, [F.OUTCOME_B]]]),
  },
};

const entryCtx: ToEntryCtx = {
  lang: F.LANG,
  didToAgent,
  seed: F.SEED,
};

const fixtures: [string, () => any][] = [
  ["AcornOutcome", () => F.wireRecord(F.smallOutcomeEntry(), { actionHash: F.OUTCOME_A })],
  ["AcornOutcome", () => F.wireRecord(F.uncertainOutcomeEntry(), { actionHash: F.OUTCOME_B })],
  ["AcornConnection", () => F.wireRecord(F.connectionEntry(), { actionHash: F.CONNECTION_AB })],
  ["AcornEntryPoint", () => F.wireRecord(F.entryPointEntry(), { actionHash: F.ENTRY_POINT_1 })],
  ["AcornOutcomeComment", () => F.wireRecord(F.outcomeCommentEntry(), { actionHash: F.COMMENT_1 })],
  ["AcornOutcomeMember", () => F.wireRecord(F.outcomeMemberEntry(), { actionHash: F.OUTCOME_MEMBER_1 })],
  ["AcornTag", () => F.wireRecord(F.tagEntry(), { actionHash: F.TAG_T })],
  ["AcornProjectMeta", () => F.wireRecord(F.projectMetaEntry(), { actionHash: F.PROJECT_META })],
  ["AcornMember", () => F.wireRecord(F.memberEntry(), { actionHash: F.MEMBER_1 })],
  ["AcornProfile", () => F.profileEntry()], // bare profile — no WireRecord
];

test("toEntry(toData(record)) rebuilds every B2 fixture entry", () => {
  for (const [className, make] of fixtures) {
    const rec = make();
    const data = toData(className, rec, dataCtx);
    const rebuilt = toEntry(className, data, entryCtx);
    // WireRecords carry `.entry`; the bare AcornProfile is its own entry.
    const expected = { ...((rec.entry ?? rec) as Record<string, unknown>) };
    if (className === "AcornProjectMeta") {
      // passphrase is never mounted; toEntry fills it from the seed
      assert.equal(rebuilt.passphrase, seedToPassphrase(F.SEED));
      delete expected.passphrase;
      const { passphrase: _p, ...rest } = rebuilt;
      assert.deepEqual(rest, expected, `${className} entry did not round-trip`);
    } else {
      assert.deepEqual(rebuilt, expected, `${className} entry did not round-trip`);
    }
  }
});

test("toEntry strips the <lang>:// prefix and converts did:key refs", () => {
  const entry = toEntry(
    "AcornConnection",
    {
      parent: `${F.LANG}://${F.OUTCOME_A}`,
      child: `${F.LANG}://${F.OUTCOME_B}`,
      siblingOrder: 3,
      randomizer: 42,
      isImported: true,
    },
    entryCtx
  );
  assert.equal(entry.parentActionHash, F.OUTCOME_A);
  assert.equal(entry.childActionHash, F.OUTCOME_B);
});
