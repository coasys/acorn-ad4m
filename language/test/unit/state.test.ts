// Lal round 2, P2 #2: revision ordering with an apply-time guard. Every
// path that writes the mounted map (signal reconciliation, the full
// resync, the write paths' snapshots) goes through MountState, which
// decides AT APPLY TIME — not when a fetch started — whether a fetched
// record may replace what is mounted.
import test from "node:test";
import assert from "node:assert/strict";
import { MountState } from "../../src/state";

const OUT = "uhCkkOUT";
const TAG = "uhCkkTAG";

const outcome = (rev: number, content: string, extra: object = {}) => ({
  class: "AcornOutcome",
  address: OUT,
  data: { content, recordUpdatedAt: rev, ...extra },
});

test("an older revision never overwrites a newer mounted one", () => {
  const s = new MountState();
  assert.equal(s.apply(outcome(20, "new"), s.beginRead()), true);
  const late = s.beginRead();
  assert.equal(s.apply(outcome(10, "old"), late), false);
  assert.equal(s.entries.get(OUT)?.data.content, "new");
});

test("out-of-order fetch completion ends on the newest revision", () => {
  // fetch A starts first and sees rev 30; fetch B starts later but its
  // (lagging) authority answers rev 20; B completes first.
  const s = new MountState();
  s.apply(outcome(10, "v10"), s.beginRead());
  const a = s.beginRead();
  const b = s.beginRead();
  s.apply(outcome(20, "v20"), b);
  s.apply(outcome(30, "v30"), a);
  assert.equal(s.entries.get(OUT)?.data.content, "v30");
  // and the reverse completion order
  const t = new MountState();
  t.apply(outcome(10, "v10"), t.beginRead());
  const a2 = t.beginRead();
  const b2 = t.beginRead();
  t.apply(outcome(30, "v30"), a2);
  t.apply(outcome(20, "v20"), b2);
  assert.equal(t.entries.get(OUT)?.data.content, "v30");
});

test("same revision: derived fields from an older read never replace a newer read's", () => {
  const s = new MountState();
  const old = s.beginRead();
  const fresh = s.beginRead();
  s.apply(outcome(10, "x", { parent: "P2" }), fresh);
  assert.equal(s.apply(outcome(10, "x", { parent: "P1" }), old), false);
  assert.equal(s.entries.get(OUT)?.data.parent, "P2");
  // a later read with the same revision does apply its derived edges
  assert.equal(s.apply(outcome(10, "x"), s.beginRead()), true);
  assert.equal(s.entries.get(OUT)?.data.parent, undefined);
});

test("an identical re-read is not a change", () => {
  const s = new MountState();
  s.apply(outcome(10, "x"), s.beginRead());
  assert.equal(s.apply(outcome(10, "x"), s.beginRead()), false);
});

test("a record mounted as class Y is never replaced by class X", () => {
  const s = new MountState();
  s.apply({ class: "AcornTag", address: TAG, data: { text: "t", recordUpdatedAt: 1 } }, s.beginRead());
  assert.equal(
    s.apply({ class: "AcornOutcome", address: TAG, data: { recordUpdatedAt: 99 } }, s.beginRead()),
    false
  );
  assert.equal(s.entries.get(TAG)?.class, "AcornTag");
});

test("a read that started before a removal cannot resurrect the record", () => {
  const s = new MountState();
  s.apply(outcome(10, "x"), s.beginRead());
  const stale = s.beginRead(); // a signal fetch starts…
  // …the record is removed (two complete absent reads, 15 s apart)
  s.applySnapshot([], s.beginRead(), { startedAt: 0 });
  const d = s.applySnapshot([], s.beginRead(), { startedAt: 15000 });
  assert.deepEqual(d.removed, [OUT]);
  assert.equal(s.apply(outcome(10, "x"), stale), false, "stale fetch resurrected");
  assert.equal(s.entries.has(OUT), false);
  // a read that starts after the removal is fresh evidence and may mount it
  assert.equal(s.apply(outcome(10, "x"), s.beginRead()), true);
});

test("full resync keeps a newer mounted revision and records applied after it began", () => {
  const s = new MountState();
  s.apply(outcome(30, "net v30"), s.beginRead()); // from a network fetch
  const resync = s.beginRead(); // local read lags: still v20, no TAG
  s.apply({ class: "AcornTag", address: TAG, data: { text: "t", recordUpdatedAt: 1 } }, s.beginRead());
  const d = s.applySnapshot([outcome(20, "local v20")], resync);
  assert.equal(s.entries.get(OUT)?.data.content, "net v30");
  assert.ok(s.entries.has(TAG), "record applied after the resync read began was removed");
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.removed, []);
});

// ---- removal needs repeated complete absence (Lal round 3, F1) -----------
//
// The stock zomes give no deletion proof (B7): a list miss may be gossip
// lag or a per-record error fetch_links dropped. A record is removed only
// after it is absent from REMOVE_AFTER (2) consecutive COMPLETE full reads
// started at least the resync interval (15 s) apart; an incomplete read
// never advances the count; any sighting resets it.

test("one complete absent read (e.g. a dropped per-record error) removes nothing", () => {
  const s = new MountState();
  s.apply(outcome(10, "x"), s.beginRead());
  const d = s.applySnapshot([], s.beginRead(), { startedAt: 0 });
  assert.deepEqual(d.removed, []);
  assert.ok(s.entries.has(OUT));
});

test("two complete absent reads spaced by the resync interval remove it", () => {
  const s = new MountState();
  s.apply(outcome(10, "x"), s.beginRead());
  assert.deepEqual(s.applySnapshot([], s.beginRead(), { startedAt: 1000 }).removed, []);
  assert.deepEqual(s.applySnapshot([], s.beginRead(), { startedAt: 16000 }).removed, [OUT]);
  assert.equal(s.entries.size, 0);
});

test("absent reads closer than the interval count once", () => {
  const s = new MountState();
  s.apply(outcome(10, "x"), s.beginRead());
  for (const t of [0, 3000, 9000, 14999]) {
    assert.deepEqual(s.applySnapshot([], s.beginRead(), { startedAt: t }).removed, [], `t=${t}`);
  }
  assert.ok(s.entries.has(OUT));
});

test("missing, then present again, resets the count", () => {
  const s = new MountState();
  s.apply(outcome(10, "x"), s.beginRead());
  s.applySnapshot([], s.beginRead(), { startedAt: 0 });
  s.applySnapshot([outcome(10, "x")], s.beginRead(), { startedAt: 15000 });
  assert.deepEqual(s.applySnapshot([], s.beginRead(), { startedAt: 30000 }).removed, []);
  assert.ok(s.entries.has(OUT));
  // a hint fetch that sees it also counts as present
  s.apply(outcome(10, "x"), s.beginRead());
  assert.deepEqual(s.applySnapshot([], s.beginRead(), { startedAt: 45000 }).removed, []);
  assert.ok(s.entries.has(OUT));
});

test("incomplete reads never advance the absence count", () => {
  const s = new MountState();
  s.apply(outcome(10, "x"), s.beginRead());
  for (const t of [0, 15000, 30000, 45000]) {
    s.applySnapshot([], s.beginRead(), { startedAt: t, complete: false });
  }
  assert.ok(s.entries.has(OUT));
  // the first COMPLETE absent read is only the first strike
  assert.deepEqual(s.applySnapshot([], s.beginRead(), { startedAt: 60000 }).removed, []);
  assert.ok(s.entries.has(OUT));
});

test("our own confirmed delete removes at once and tombstones", () => {
  const s = new MountState();
  s.apply(outcome(10, "x"), s.beginRead());
  const stale = s.beginRead();
  assert.deepEqual(s.removeConfirmed([OUT, "uhCkkNOTMOUNTED"]), [OUT]);
  assert.equal(s.entries.has(OUT), false);
  assert.equal(s.apply(outcome(10, "x"), stale), false);
});
