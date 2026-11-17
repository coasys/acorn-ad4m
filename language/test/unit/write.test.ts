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
  _resetCommittedForTests,
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

test.beforeEach(() => _resetCommittedForTests());

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
        if (fn === "fetch_tags") return []; // pre-commit identical check
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
    ctx({
      call: async (_z, fn) => (fn === "fetch_tags" ? [] : first),
      snapshot: async () => snap,
    })
  );
  // the second preflight lists the first record: no second commit
  const r2 = await createRecord(
    "AcornTag",
    params,
    ctx({
      call: async (_z, fn) => (fn === "fetch_tags" ? [first] : second),
      snapshot: async () => snap,
    })
  );
  assert.equal(r1.address, TAG_T);
  assert.equal(r2.address, TAG_T);
});

// ---- create: never an unmounted URL (Lal round 2, P2 #4) -------------------

test("create never reports an unmounted URL: no snapshot match rejects, create ran once", async () => {
  // The record committed but the mount does not list it (yet): the
  // interaction must NOT answer the raw action hash as if it were mounted,
  // and must not replay the create — it rejects naming what was committed.
  const wr = { ...wireRecord(tagEntry(), { actionHash: TAG_T }), entryHash: ENTRY_HASH };
  let creates = 0;
  let snaps = 0;
  await assert.rejects(
    createRecord(
      "AcornTag",
      { text: "urgent", backgroundColor: "#112233" },
      ctx({
        call: async (_z, fn) => {
          if (fn === "fetch_tags") return [];
          assert.equal(fn, "create_tag");
          creates++;
          return wr;
        },
        snapshot: async () => {
          snaps++;
          return { entries: [] };
        },
        reconcileMs: 30,
        reconcileDelayMs: 5,
      })
    ),
    (e: any) => {
      assert.match(e.message, /committed/);
      assert.match(e.message, new RegExp(TAG_T));
      assert.deepEqual(e.committed, [TAG_T]);
      return true;
    }
  );
  assert.equal(creates, 1, "the create was replayed");
  assert.ok(snaps >= 2, `post-commit reconciliation re-read only ${snaps}x`);
});

test("a failing post-commit snapshot is re-read, never re-committed", async () => {
  const wr = { ...wireRecord(tagEntry(), { actionHash: TAG_T }), entryHash: ENTRY_HASH };
  let creates = 0;
  let snaps = 0;
  const res = await createRecord(
    "AcornTag",
    { text: "urgent", backgroundColor: "#112233" },
    ctx({
      call: async (_z, fn) => {
        if (fn === "fetch_tags") return [];
        creates++;
        return wr;
      },
      snapshot: async () => {
        if (++snaps === 1) throw new Error("snapshot read timed out");
        return { entries: [snapEntry("AcornTag", wr)] };
      },
      reconcileMs: 1000,
      reconcileDelayMs: 5,
    })
  );
  assert.equal(creates, 1);
  assert.equal(res.address, TAG_T);
  assert.deepEqual(res.changed.map((e) => e.address), [TAG_T]);
});

test("concurrent identical creates commit once and answer the same mounted URL", async () => {
  // Two interactions create a byte-identical tag at the same time. They
  // are serialized; the second finds the first's record (same entry) in a
  // fresh read and answers its mounted address without a second commit —
  // a second action would make fetch_tags' canonical pick unstable.
  const wr = { ...wireRecord(tagEntry(), { actionHash: TAG_T }), entryHash: ENTRY_HASH };
  let committed = false;
  let creates = 0;
  const c = ctx({
    call: async (_z, fn) => {
      if (fn === "fetch_tags") return committed ? [wr] : [];
      assert.equal(fn, "create_tag");
      creates++;
      await new Promise((r) => setTimeout(r, 10));
      committed = true;
      return wr;
    },
    snapshot: async () => ({
      entries: committed ? [snapEntry("AcornTag", wr)] : [],
    }),
  });
  const params = { text: "urgent", backgroundColor: "#112233" };
  const [r1, r2] = await Promise.all([
    createRecord("AcornTag", params, c),
    createRecord("AcornTag", params, c),
  ]);
  assert.equal(creates, 1, "identical concurrent creates committed twice");
  assert.equal(r1.address, TAG_T);
  assert.equal(r2.address, TAG_T);
  assert.deepEqual(r2.changed.map((e) => e.address), [TAG_T]);
});

// ---- update: old + new connection endpoints (B6, Lal P2) -------------------

test("connection update returns the connection plus old and new endpoints", async () => {
  // Move CONNECTION_AB from OUTCOME_B to OUTCOME_C under the same parent
  // OUTCOME_A. The synchronous delta must re-expand every outcome whose
  // mounted parent/children changed: old child B and new child C (and the
  // parent A if an end moved across parents — covered by the same rule).
  const current = wireRecord(connectionEntry(), { actionHash: CONNECTION_AB });
  const moved = wireRecord(
    { ...connectionEntry(), childActionHash: OUTCOME_C },
    { actionHash: CONNECTION_AB }
  );
  const outcomes = [OUTCOME_A, OUTCOME_B, OUTCOME_C].map((h) =>
    snapEntry("AcornOutcome", wireRecord(uncertainOutcomeEntry(), { actionHash: h }))
  );
  const res = await updateRecord(
    "AcornConnection",
    CONNECTION_AB,
    { child: url(OUTCOME_C) },
    ctx({
      call: async (_z, fn) => {
        if (fn === "fetch_connections") return [current];
        if (fn === "update_connection") return moved;
        throw new Error(`unexpected zome call ${fn}`);
      },
      snapshot: async () => ({
        entries: [snapEntry("AcornConnection", moved), ...outcomes],
      }),
    })
  );
  assert.deepEqual(
    new Set(res.changed.map((e) => e.address)),
    new Set([CONNECTION_AB, OUTCOME_A, OUTCOME_B, OUTCOME_C])
  );
});

test("connection update to a new parent returns both old parents and the child", async () => {
  // Re-parent CONNECTION_AB from OUTCOME_A to OUTCOME_C: old parent A and
  // new parent C both change their `children`, child B keeps its `parent`
  // edge but is still re-expanded — every affected outcome is in the delta.
  const current = wireRecord(connectionEntry(), { actionHash: CONNECTION_AB });
  const moved = wireRecord(
    { ...connectionEntry(), parentActionHash: OUTCOME_C },
    { actionHash: CONNECTION_AB }
  );
  const outcomes = [OUTCOME_A, OUTCOME_B, OUTCOME_C].map((h) =>
    snapEntry("AcornOutcome", wireRecord(smallOutcomeEntry(), { actionHash: h }))
  );
  const res = await updateRecord(
    "AcornConnection",
    CONNECTION_AB,
    { parent: url(OUTCOME_C) },
    ctx({
      call: async (_z, fn) => {
        if (fn === "fetch_connections") return [current];
        if (fn === "update_connection") return moved;
        throw new Error(`unexpected zome call ${fn}`);
      },
      snapshot: async () => ({
        entries: [snapEntry("AcornConnection", moved), ...outcomes],
      }),
    })
  );
  assert.deepEqual(
    new Set(res.changed.map((e) => e.address)),
    new Set([CONNECTION_AB, OUTCOME_A, OUTCOME_B, OUTCOME_C])
  );
});

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

// ---- create: a failed/incomplete preflight is no licence to commit ---------
// (Lal round 3, F4)

const tagParams = { text: "urgent", backgroundColor: "#112233" };

test("failed preflight read rejects and commits nothing", async () => {
  let creates = 0;
  await assert.rejects(
    createRecord(
      "AcornTag",
      tagParams,
      ctx({
        call: async (_z, fn) => {
          if (fn === "fetch_tags") throw new Error("source chain read timed out");
          creates++;
          return {};
        },
      })
    ),
    /preflight/
  );
  assert.equal(creates, 0);
});

test("concurrent identical creates with a failing second preflight commit once", async () => {
  const wr = { ...wireRecord(tagEntry(), { actionHash: TAG_T }), entryHash: ENTRY_HASH };
  let committed = false;
  let creates = 0;
  let preflights = 0;
  const c = ctx({
    call: async (_z, fn) => {
      if (fn === "fetch_tags") {
        if (++preflights === 2) throw new Error("read failed");
        return committed ? [wr] : [];
      }
      creates++;
      committed = true;
      return wr;
    },
    snapshot: async () => ({ entries: committed ? [snapEntry("AcornTag", wr)] : [] }),
  });
  const res = await Promise.allSettled([
    createRecord("AcornTag", tagParams, c),
    createRecord("AcornTag", tagParams, c),
  ]);
  assert.equal(creates, 1, "committed twice");
  assert.equal(res[0].status, "fulfilled");
  if (res[1].status === "fulfilled") assert.equal(res[1].value.address, TAG_T);
});

test("an incomplete second preflight (omits our own commit) never commits twice", async () => {
  // the second read succeeds but does not list the record this language
  // committed a moment ago — the identity we retained says it exists.
  const wr = { ...wireRecord(tagEntry(), { actionHash: TAG_T }), entryHash: ENTRY_HASH };
  let creates = 0;
  const c = ctx({
    call: async (_z, fn) => {
      if (fn === "fetch_tags") return [];
      creates++;
      return wr;
    },
    snapshot: async () => ({ entries: [snapEntry("AcornTag", wr)] }),
  });
  const r1 = await createRecord("AcornTag", tagParams, c);
  assert.equal(r1.address, TAG_T);
  const r2 = await createRecord("AcornTag", tagParams, c).then(
    (v) => v,
    (e) => e
  );
  assert.equal(creates, 1, "committed twice");
  if (!(r2 instanceof Error)) assert.equal(r2.address, TAG_T);
  else assert.match(r2.message, /preflight|already committed/);
});
