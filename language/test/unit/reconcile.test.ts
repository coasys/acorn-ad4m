// Lal round 2, P2 #3 (bounded signal work) and #2 (dirty generation,
// two changes inside one window). The Reconciler is the one worker that
// turns signal hints into verified mount changes: hints only mark targets
// dirty; one loop fetches each needed collection once per pass, applies
// through MountState's guard, and re-checks targets that were re-hinted
// while a fetch was in flight.
import test from "node:test";
import assert from "node:assert/strict";
import { Reconciler, type ReconcilerOpts } from "../../src/reconcile";
import { MountState } from "../../src/state";
import type { FetchKind } from "../../src/signals";
import { LANG, OUTCOME_A, smallOutcomeEntry, wireRecord } from "./fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REV0 = 1763370000000000;

const outcome = (addr: string, rev: number, content = `v${rev}`) => ({
  ...wireRecord({ ...smallOutcomeEntry(), content }, { actionHash: addr }),
  updatedAt: rev,
});

const hint = (action: string, rec: any) => ({
  signalType: "Outcome",
  data: { entryType: "outcome", action, data: rec },
});

function mk(over: Partial<ReconcilerOpts> & { fetch: ReconcilerOpts["fetch"] }) {
  const state = over.state ?? new MountState();
  const emitted: any[] = [];
  let resyncs = 0;
  const r = new Reconciler({
    lang: LANG,
    state,
    emit: (d) => emitted.push(d),
    resync: async () => {
      resyncs++;
      return { changed: [], removed: [] };
    },
    budgetMs: 200,
    retryMs: 5,
    fetchTimeoutMs: 100,
    ...over,
  });
  r.start();
  return { r, state, emitted, resyncs: () => resyncs };
}

// bounded: idle() must resolve within `ms` or the test fails (not hangs)
async function idleWithin(r: Reconciler, ms: number) {
  const t0 = Date.now();
  await Promise.race([
    r.idle(),
    sleep(ms).then(() => {
      throw new Error(`worker still busy after ${ms} ms`);
    }),
  ]);
  return Date.now() - t0;
}

const addr = (i: number) => `uhCkkOUTCOME${String(i).padStart(4, "0")}`;

test("pending work is capped; overflow falls back to ONE full resync (#3)", async () => {
  const { r, resyncs } = mk({ fetch: async () => [], maxPending: 10 });
  for (let i = 0; i < 50; i++) r.hint(hint("create", outcome(addr(i), REV0)));
  assert.ok(r.pending <= 10, `pending ${r.pending} > cap 10`);
  await idleWithin(r, 2000);
  assert.equal(resyncs(), 1, "overflow did not fall back to exactly one full resync");
});

test("a burst of hints costs one fetch per collection per pass (#3)", async () => {
  let fetches = 0;
  const recs = Array.from({ length: 100 }, (_, i) => outcome(addr(i), REV0));
  const { r, state } = mk({
    fetch: async (kind: FetchKind) => {
      fetches++;
      await sleep(5);
      return kind === "outcomes" ? recs : [];
    },
    maxPending: 1000,
  });
  for (const rec of recs) r.hint(hint("create", rec));
  await idleWithin(r, 2000);
  assert.equal(state.entries.size, 100);
  assert.ok(fetches <= 4, `${fetches} fetches for 100 hints`);
});

test("a slow fetch cannot stretch reconciliation past the wall-clock budget (#3)", async () => {
  // never satisfied (the record never appears); every fetch takes 40 ms.
  const { r } = mk({
    fetch: async () => {
      await sleep(40);
      return [];
    },
    budgetMs: 150,
    retryMs: 1,
    fetchTimeoutMs: 100,
  });
  r.hint(hint("create", outcome(OUTCOME_A, REV0)));
  const ms = await idleWithin(r, 2000);
  assert.ok(ms < 400, `worker ran ${ms} ms on a 150 ms budget`);
});

test("a hung fetch is inconclusive, not a stall (#3)", async () => {
  const { r, state } = mk({
    fetch: () => new Promise(() => {}),
    budgetMs: 100,
    fetchTimeoutMs: 30,
  });
  r.hint(hint("create", outcome(OUTCOME_A, REV0)));
  await idleWithin(r, 1000);
  assert.equal(state.entries.size, 0);
});

test("a hint arriving during a fetch is reconciled after it (#2 dirty generation)", async () => {
  // fetch #1 is in flight answering v20 when the v30 hint lands; the
  // 400 ms freshness cache used to serve v20 to that second hint.
  const state = new MountState();
  state.apply(
    { class: "AcornOutcome", address: OUTCOME_A, data: { recordUpdatedAt: REV0 + 10, content: "v10" } },
    state.beginRead()
  );
  let n = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { r } = mk({
    state,
    budgetMs: 150,
    fetch: async (kind) => {
      if (kind !== "outcomes") return [];
      if (++n === 1) {
        await gate;
        return [outcome(OUTCOME_A, REV0 + 20)];
      }
      return [outcome(OUTCOME_A, REV0 + 30)];
    },
  });
  r.hint(hint("update", outcome(OUTCOME_A, REV0 + 20)));
  await sleep(5);
  r.hint(hint("update", outcome(OUTCOME_A, REV0 + 30)));
  release();
  await idleWithin(r, 2000);
  assert.equal(state.entries.get(OUTCOME_A)?.data.content, `v${REV0 + 30}`);
});

test("two updates hinted before any fetch: the worker waits for the second (#2)", async () => {
  // fetches answer v20, v20, then v30: stopping at the first newer stamp
  // would leave the mount on v20.
  const state = new MountState();
  state.apply(
    { class: "AcornOutcome", address: OUTCOME_A, data: { recordUpdatedAt: REV0 + 10, content: "v10" } },
    state.beginRead()
  );
  const answers = [REV0 + 20, REV0 + 20, REV0 + 30];
  let n = 0;
  const { r } = mk({
    state,
    budgetMs: 300,
    fetch: async (kind) =>
      kind === "outcomes"
        ? [outcome(OUTCOME_A, answers[Math.min(n++, answers.length - 1)])]
        : [],
  });
  r.hint(hint("update", outcome(OUTCOME_A, REV0 + 20)));
  r.hint(hint("update", outcome(OUTCOME_A, REV0 + 30)));
  await idleWithin(r, 2000);
  assert.equal(state.entries.get(OUTCOME_A)?.data.content, `v${REV0 + 30}`);
});

test("a fetch that lands after a newer revision was mounted elsewhere changes nothing (#2)", async () => {
  const state = new MountState();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { r, emitted } = mk({
    state,
    budgetMs: 50,
    fetch: async (kind) => {
      if (kind !== "outcomes") return [];
      await gate;
      return [outcome(OUTCOME_A, REV0 + 10)];
    },
  });
  r.hint(hint("create", outcome(OUTCOME_A, REV0 + 10)));
  await sleep(5);
  // meanwhile a resync read (begun later) mounts v20
  state.apply(
    { class: "AcornOutcome", address: OUTCOME_A, data: { recordUpdatedAt: REV0 + 20, content: "v20" } },
    state.beginRead()
  );
  release();
  await idleWithin(r, 1000);
  assert.equal(state.entries.get(OUTCOME_A)?.data.content, "v20");
  assert.equal(emitted.length, 0);
});

test("delete hints queue nothing and fetch nothing (P1)", async () => {
  let fetches = 0;
  const { r } = mk({
    fetch: async () => {
      fetches++;
      return [];
    },
  });
  r.hint(hint("delete", OUTCOME_A));
  r.hint({
    signalType: "DeleteOutcomeFully",
    data: { entryType: "x", action: "delete", data: { outcomeActionHash: OUTCOME_A } },
  });
  assert.equal(r.pending, 0);
  await idleWithin(r, 500);
  assert.equal(fetches, 0);
});
