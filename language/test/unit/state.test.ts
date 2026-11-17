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
  const resync = s.beginRead(); // …a resync read starts, without OUT
  const d = s.applySnapshot([], resync);
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

test("full resync removes records absent from a read that began after they mounted", () => {
  const s = new MountState();
  s.apply(outcome(10, "x"), s.beginRead());
  const d = s.applySnapshot([], s.beginRead());
  assert.deepEqual(d.removed, [OUT]);
  assert.equal(s.entries.size, 0);
});
