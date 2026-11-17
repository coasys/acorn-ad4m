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

// ---- before the first snapshot (Lal round 2, remaining checks) ------------

function unstarted(state: MountState, maxPending: number) {
  let resyncs = 0;
  const r = new Reconciler({
    lang: LANG,
    state,
    fetch: async () => [],
    emit: () => {},
    resync: async () => {
      resyncs++;
      return { changed: [], removed: [] };
    },
    budgetMs: 50,
    retryMs: 5,
    maxPending,
  });
  return { r, resyncs: () => resyncs };
}

test("overflow before init that the init read covers costs no extra resync", async () => {
  const state = new MountState();
  const { r, resyncs } = unstarted(state, 5);
  for (let i = 0; i < 20; i++) r.hint(hint("create", outcome(addr(i), REV0)));
  const initRead = state.beginRead(); // the first snapshot begins after them
  r.start(initRead);
  await idleWithin(r, 1000);
  assert.equal(resyncs(), 0);
});

test("overflow with a hint dropped DURING the init read still resyncs after init", async () => {
  const state = new MountState();
  const { r, resyncs } = unstarted(state, 5);
  for (let i = 0; i < 10; i++) r.hint(hint("create", outcome(addr(i), REV0)));
  const initRead = state.beginRead();
  r.hint(hint("create", outcome(addr(99), REV0))); // lands mid-read
  r.start(initRead);
  await idleWithin(r, 1000);
  assert.equal(resyncs(), 1);
});

// ---- bounded outstanding work (Lal round 3, F3) ----------------------------

test("a hung overflow resync does not stall the worker (F3)", async () => {
  const state = new MountState();
  let resyncs = 0;
  const later = outcome(addr(500), REV0);
  const r = new Reconciler({
    lang: LANG,
    state,
    fetch: async (kind: string) => (kind === "outcomes" ? [later] : []),
    emit: () => {},
    resync: () => {
      resyncs++;
      return new Promise(() => {}); // never settles
    },
    maxPending: 3,
    budgetMs: 2000,
    retryMs: 5,
    overflowTimeoutMs: 30,
  } as any);
  r.start();
  for (let i = 0; i < 10; i++) r.hint(hint("create", outcome(addr(i), REV0)));
  await sleep(80);
  r.hint(hint("create", later)); // ordinary work after the hung resync
  const t0 = Date.now();
  while (!state.entries.has(later.actionHash) && Date.now() - t0 < 1500) await sleep(10);
  assert.ok(state.entries.has(later.actionHash), "worker stalled behind the hung resync");
  assert.equal(resyncs, 1, "a second resync started while the first never settled");
});

test("a late overflow resync result is fenced off after its deadline (F3)", async () => {
  let token: any = null;
  const emitted: any[] = [];
  const r = new Reconciler({
    lang: LANG,
    state: new MountState(),
    fetch: async () => [],
    emit: (d: any) => emitted.push(d),
    resync: (fence: any) => {
      token = fence;
      return sleep(100).then(() => ({
        changed: [{ class: "AcornOutcome", address: "LATE", data: {} }],
        removed: [],
      }));
    },
    maxPending: 2,
    budgetMs: 50,
    overflowTimeoutMs: 20,
  } as any);
  r.start();
  for (let i = 0; i < 5; i++) r.hint(hint("create", outcome(addr(i), REV0)));
  await sleep(200);
  assert.ok(token && typeof token.stale === "function", "resync got no fence");
  assert.equal(token.stale(), true, "timed-out resync not marked stale");
  assert.equal(emitted.length, 0, "late resync delta emitted");
});

test("outstanding host calls stay at or below the cap across repeated timeouts (F3)", async () => {
  let started = 0;
  let maxOpen = 0;
  let open = 0;
  const r = new Reconciler({
    lang: LANG,
    state: new MountState(),
    fetch: () => {
      started++;
      open++;
      maxOpen = Math.max(maxOpen, open);
      return new Promise(() => {}); // hung: never settles, so `open` never drops
    },
    emit: () => {},
    resync: async () => ({ changed: [], removed: [] }),
    budgetMs: 300,
    retryMs: 1,
    fetchTimeoutMs: 5,
    maxOutstanding: 4,
  } as any);
  r.start();
  for (let i = 0; i < 20; i++) r.hint(hint("create", outcome(addr(i), REV0)));
  r.hint({
    signalType: "Tag",
    data: { entryType: "tag", action: "create", data: { actionHash: "uhCkkTAG1" } },
  });
  await idleWithin(r, 2000);
  assert.ok(maxOpen <= 4, `outstanding calls reached ${maxOpen} (cap 4)`);
  assert.ok(started <= 2, `${started} calls started for 2 hung collections`);
});

test("repeated bursts during a slow resync schedule at most one more (F3)", async () => {
  let resyncs = 0;
  const r = new Reconciler({
    lang: LANG,
    state: new MountState(),
    fetch: async () => [],
    emit: () => {},
    resync: async () => {
      resyncs++;
      await sleep(60);
      return { changed: [], removed: [] };
    },
    maxPending: 3,
    budgetMs: 30,
    retryMs: 1,
  });
  r.start();
  for (let burst = 0; burst < 6; burst++) {
    for (let i = 0; i < 10; i++) r.hint(hint("create", outcome(addr(burst * 100 + i), REV0)));
    await sleep(5);
  }
  await idleWithin(r, 2000);
  assert.ok(resyncs <= 2, `${resyncs} resyncs for bursts during one`);
});

test("re-hints cannot keep a record dirty forever (F3)", async () => {
  const r = new Reconciler({
    lang: LANG,
    state: new MountState(),
    fetch: async () => [],
    emit: () => {},
    resync: async () => ({ changed: [], removed: [] }),
    budgetMs: 40,
    retryMs: 2,
  });
  r.start();
  // re-hinted every 10 ms for 300 ms: one dirty record may live at most
  // 3x its budget (120 ms) from its first hint, so it must expire
  const t0 = Date.now();
  while (Date.now() - t0 < 300) {
    r.hint(hint("update", outcome(OUTCOME_A, REV0)));
    await sleep(10);
  }
  assert.ok(r.stats.expired >= 1, "re-hints kept one dirty record alive for 300 ms (budget 40)");
  await idleWithin(r, 1000);
});

// ---- reused reads vs newer hints (Lal round 4, P2-1) -----------------------

test("a reused read older than a hint cannot resolve it; a fresh read does (round 4)", async () => {
  // B is mounted at v10. A's create hint starts a read that times out but
  // stays outstanding. B then gets an update hint (claim v30). The next
  // pass REUSES the old read, which answers B at v20 — newer than mounted
  // and within the claim's 1 s tolerance — so it may apply, but B must
  // stay dirty until a read started after its hint: that one shows v30.
  const B = addr(2);
  const state = new MountState();
  state.apply(
    { class: "AcornOutcome", address: B, data: { recordUpdatedAt: REV0 + 10, content: "v10" } },
    state.beginRead()
  );
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const r = new Reconciler({
    lang: LANG,
    state,
    fetch: async (kind: string) => {
      if (kind !== "outcomes") return [];
      if (++calls === 1) {
        await gate;
        return [outcome(addr(1), REV0), outcome(B, REV0 + 20)];
      }
      return [outcome(addr(1), REV0), outcome(B, REV0 + 30)];
    },
    emit: () => {},
    resync: async () => ({ changed: [], removed: [] }),
    budgetMs: 3000,
    retryMs: 40,
    fetchTimeoutMs: 15,
  });
  r.start();
  r.hint(hint("create", outcome(addr(1), REV0)));
  await sleep(25); // pass 1 timed out; its read is still outstanding
  assert.equal(calls, 1);
  r.hint(hint("update", outcome(B, REV0 + 30)));
  // release the old read once the next pass is waiting on it
  const passes = r.stats.passes;
  while (r.stats.passes === passes) await sleep(1);
  release();
  await idleWithin(r, 2000);
  assert.ok(calls >= 2, "no fresh read after B's hint — B was resolved by the reused read");
  assert.equal(state.entries.get(B)?.data.content, `v${REV0 + 30}`);
});
