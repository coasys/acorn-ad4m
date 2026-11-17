// Lal round 3, F2: derived relations (an outcome's parent/children) must
// come only from connections that passed the revision guard, and a
// connection list that lacks a mounted connection must not erase its
// edge (the F1 rule: absence is not deletion). Plus the ordering choices
// for profiles (no revision) and same-millisecond updates.
import test from "node:test";
import assert from "node:assert/strict";
import { agentToDid } from "../../src/agent";
import { deriveRelations, toData, type MapCtx } from "../../src/mapping";
import { Reconciler } from "../../src/reconcile";
import { MountState } from "../../src/state";
import {
  CONNECTION_AB,
  LANG,
  OUTCOME_A,
  OUTCOME_B,
  connectionEntry,
  profileEntry,
  smallOutcomeEntry,
  uncertainOutcomeEntry,
  wireRecord,
  AGENT_A,
} from "./fixtures";

const OUTCOME_F = "uhCkkT3V0Y29tZUYuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
const url = (h: string) => `${LANG}://${h}`;
const REV = 1763370000000000;

const outA = () => ({ ...wireRecord(smallOutcomeEntry(), { actionHash: OUTCOME_A }), updatedAt: REV });
const outB = () => ({ ...wireRecord(uncertainOutcomeEntry(), { actionHash: OUTCOME_B }), updatedAt: REV });
const outF = () => ({
  ...wireRecord({ ...uncertainOutcomeEntry(), content: "F" }, { actionHash: OUTCOME_F }),
  updatedAt: REV,
});
// connection A->child at revision rev
const conn = (child: string, rev: number) => ({
  ...wireRecord({ ...connectionEntry(), childActionHash: child }, { actionHash: CONNECTION_AB }),
  updatedAt: rev,
});

function mctx(conns: any[]): MapCtx {
  return { lang: LANG, hashToUrl: url, agentToDid, derived: deriveRelations(conns) };
}

// The mount after a successful LOCAL move of the connection A->B to A->F
// (revision REV+20): B has no parent, F's parent is A.
function movedState(): MountState {
  const s = new MountState();
  const seq = s.beginRead();
  const c = conn(OUTCOME_F, REV + 20);
  const m = mctx([c]);
  for (const [cls, rec] of [
    ["AcornOutcome", outA()],
    ["AcornOutcome", outB()],
    ["AcornOutcome", outF()],
    ["AcornConnection", c],
  ] as const) {
    s.apply({ class: cls, address: rec.actionHash, data: toData(cls, rec, m) }, seq);
  }
  return s;
}

function worker(state: MountState, rows: Record<string, any[]>) {
  const emitted: any[] = [];
  const r = new Reconciler({
    lang: LANG,
    state,
    fetch: async (kind) => rows[kind] ?? [],
    emit: (d) => emitted.push(d),
    resync: async () => ({ changed: [], removed: [] }),
    budgetMs: 30,
    retryMs: 2,
  });
  r.start();
  return { r, emitted };
}

const hint = (signalType: string, entryType: string, action: string, data: any) => ({
  signalType,
  data: { entryType, action, data },
});

test("a rejected stale connection fetch does not feed expansion (F2)", async () => {
  // our own update's echo: a lagging authority still answers A->B @REV+10
  const s = movedState();
  const { r } = worker(s, {
    connections: [conn(OUTCOME_B, REV + 10)],
    outcomes: [outA(), outB(), outF()],
  });
  r.hint(hint("Connection", "connection", "update", conn(OUTCOME_F, REV + 20)));
  await r.idle();
  assert.equal(s.entries.get(CONNECTION_AB)?.data.child, url(OUTCOME_F), "stale connection applied");
  assert.equal(s.entries.get(OUTCOME_B)?.data.parent, undefined, "B regained the stale parent");
  assert.equal(s.entries.get(OUTCOME_F)?.data.parent, url(OUTCOME_A), "F lost its parent");
  assert.deepEqual(s.entries.get(OUTCOME_A)?.data.children, [url(OUTCOME_F)]);
});

test("an outcome fetch with a connection list missing the edge keeps it (F2)", async () => {
  // fetch_connections silently dropped A->F (per-record error / gossip)
  const s = movedState();
  const { r } = worker(s, { connections: [], outcomes: [outA(), outB(), outF()] });
  r.hint(hint("Outcome", "outcome", "create", outF()));
  r.hint(hint("Outcome", "outcome", "create", outA()));
  await r.idle();
  assert.equal(s.entries.get(OUTCOME_F)?.data.parent, url(OUTCOME_A), "edge erased");
  assert.deepEqual(s.entries.get(OUTCOME_A)?.data.children, [url(OUTCOME_F)], "edge erased");
});

test("same-millisecond updates converge on the higher µs whatever the read order (F2)", () => {
  // stock picks among same-ms updates by details order (unspecified); the
  // guard orders by the µs stamp so the mount does not flap between them
  for (const order of [[1, 2], [2, 1]]) {
    const s = new MountState();
    const recs: Record<number, any> = {
      1: { class: "AcornOutcome", address: OUTCOME_A, data: { content: "u1", recordUpdatedAt: REV + 100 } },
      2: { class: "AcornOutcome", address: OUTCOME_A, data: { content: "u2", recordUpdatedAt: REV + 900 } },
    };
    for (const i of order) s.apply(recs[i], s.beginRead());
    for (const i of order) s.apply(recs[i], s.beginRead()); // and again, alternating
    assert.equal(s.entries.get(OUTCOME_A)?.data.content, "u2", `order ${order}`);
  }
});

test("profiles (no revision): a lagging read that started earlier never reverts (F2)", () => {
  const s = new MountState();
  const addr = `profile/${AGENT_A}`;
  const lagging = s.beginRead(); // local read starts, sees the old profile
  const fresh = s.beginRead(); // network read starts later, sees the new one
  const p = (handle: string) => ({
    class: "AcornProfile",
    address: addr,
    data: toData("AcornProfile", { ...profileEntry(), handle }, mctx([])),
  });
  assert.equal(s.apply(p("new"), fresh), true);
  assert.equal(s.apply(p("old"), lagging), false);
  assert.equal(s.entries.get(addr)?.data.handle, "new");
});
