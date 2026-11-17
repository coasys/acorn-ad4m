// B6 unit tests for the write path — injected `call`/`snapshot` stand in
// for the zomes (see WriteCtx). Lal review P2:
//
//   "Identical creates can return an address absent from the mount":
//   hdk_crud's do_create always commits a NEW action and returns its hash,
//   but fetch_* lists one record per ENTRY under the ORIGINAL create
//   action (get_latest_for_entry → details.actions.first()). A repeated
//   byte-identical create therefore answers an actionHash the mount never
//   lists — create must reconcile the response to the address the fresh
//   snapshot lists for the same entryHash.

import test from "node:test";
import assert from "node:assert/strict";
import { agentToDid } from "../../src/agent";
import { toData, type MapCtx } from "../../src/mapping";
import {
  createRecord,
  updateRecord,
  type WriteCtx,
} from "../../src/write";
import {
  AGENT_A,
  CONNECTION_AB,
  ENTRY_HASH,
  LANG,
  OUTCOME_A,
  OUTCOME_B,
  SEED,
  TAG_T,
  connectionEntry,
  smallOutcomeEntry,
  tagEntry,
  uncertainOutcomeEntry,
  wireRecord,
} from "./fixtures";

const OUTCOME_C = "uhCkkT3V0Y29tZUMuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";

const mapCtx: MapCtx = {
  lang: LANG,
  hashToUrl: (h) => `${LANG}://${h}`,
  agentToDid,
};

const url = (h: string) => `${LANG}://${h}`;

/** A SnapshotEntry as the mount would list `record` of `className`. */
function snapEntry(className: string, record: any) {
  const data = toData(className, record, mapCtx);
  const address =
    className === "AcornProfile"
      ? `profile/${(record?.entry ?? record).agentPubKey}`
      : record.actionHash;
  return { class: className, address, data };
}

function ctx(over: Partial<WriteCtx> = {}): WriteCtx {
  return {
    lang: LANG,
    ownAgent: AGENT_A,
    ad4mDid: "did:key:zExecutorTest",
    seed: SEED,
    call: async (_z, fn) => {
      throw new Error(`unexpected zome call ${fn}`);
    },
    snapshot: async () => ({ entries: [] }),
    ...over,
  };
}

// ---- create: canonical mounted address (B6, Lal P2) ------------------------

test("create returns the canonical mounted address for a deduped entry", async () => {
  // create_tag's response carries the SECOND create's actionHash, but the
  // mount lists the entry under the ORIGINAL action — the address the
  // interaction returns must be the snapshot's, not the response's.
  const canonical = { ...wireRecord(tagEntry(), { actionHash: TAG_T }), entryHash: ENTRY_HASH };
  const dupe = { ...canonical, actionHash: "uhCkkSECONDcreateactionhashxxxxxxxxxxxxx" };
  const res = await createRecord(
    "AcornTag",
    { text: "urgent", backgroundColor: "#112233" },
    ctx({
      call: async (_z, fn) => {
        assert.equal(fn, "create_tag");
        return dupe;
      },
      snapshot: async () => ({ entries: [snapEntry("AcornTag", canonical)] }),
    })
  );
  assert.equal(res.address, TAG_T);
  assert.deepEqual(
    res.changed.map((e) => e.address),
    [TAG_T]
  );
});

test("repeated identical create returns the same mounted address twice", async () => {
  // Two creates of a byte-identical tag: the first mounts under action A;
  // the second's fresh action B is deduped away by fetch_tags. Both
  // interactions must answer the mounted A.
  const first = { ...wireRecord(tagEntry(), { actionHash: TAG_T }), entryHash: ENTRY_HASH };
  const second = { ...first, actionHash: "uhCkkSECONDcreateactionhashxxxxxxxxxxxxx" };
  const snap = { entries: [snapEntry("AcornTag", first)] };
  const params = { text: "urgent", backgroundColor: "#112233" };

  const r1 = await createRecord(
    "AcornTag",
    params,
    ctx({ call: async () => first, snapshot: async () => snap })
  );
  const r2 = await createRecord(
    "AcornTag",
    params,
    ctx({ call: async () => second, snapshot: async () => snap })
  );
  assert.equal(r1.address, TAG_T);
  assert.equal(r2.address, TAG_T);
});

test("create keeps the returned hash when the snapshot has no entryHash match", async () => {
  // Fallback: a record not yet in the snapshot (or one whose entryHash is
  // not mounted — profiles aside, every WireRecord mounts entryHash) keeps
  // the hash the zome answered rather than failing the create.
  const wr = { ...wireRecord(tagEntry(), { actionHash: TAG_T }), entryHash: ENTRY_HASH };
  const res = await createRecord(
    "AcornTag",
    { text: "urgent", backgroundColor: "#112233" },
    ctx({ call: async () => wr, snapshot: async () => ({ entries: [] }) })
  );
  assert.equal(res.address, TAG_T);
  assert.deepEqual(res.changed, []);
});

// ---- update: old + new connection endpoints (B6, Lal P2) -------------------

test("outcome update returns just the outcome (no derived fields move)", async () => {
  const current = wireRecord(uncertainOutcomeEntry(), { actionHash: OUTCOME_A });
  const renamed = wireRecord(
    { ...uncertainOutcomeEntry(), content: "renamed" },
    { actionHash: OUTCOME_A }
  );
  const res = await updateRecord(
    "AcornOutcome",
    OUTCOME_A,
    { content: "renamed" },
    ctx({
      call: async (_z, fn) => {
        if (fn === "fetch_outcomes") return [current];
        if (fn === "update_outcome") return renamed;
        throw new Error(`unexpected zome call ${fn}`);
      },
      snapshot: async () => ({ entries: [snapEntry("AcornOutcome", renamed)] }),
    })
  );
  assert.deepEqual(
    res.changed.map((e) => e.address),
    [OUTCOME_A]
  );
});
