// The signal reconciliation worker (Lal round 2, P2 #2 and #3).
//
// A signal is a hint (signals.ts `hintTargets`): it only marks records
// dirty. ONE worker per language turns dirty records into verified mount
// changes:
//
//  - Bounded: at most `maxPending` distinct dirty records (default 256).
//    A hint that would exceed it drops the queue and schedules ONE full
//    resync instead (the same read as mountSnapshot); hints arriving
//    before that resync's read begins are covered by it and dropped.
//  - Coalesced: each pass fetches every collection the due records need
//    exactly once (network get), however many hints named them.
//  - Real deadlines: a record stays dirty for at most `budgetMs` of wall
//    clock (default 13 s) from when the worker could first act on it;
//    each fetch is cut off at `fetchTimeoutMs` (default 10 s) or the
//    latest due deadline, whichever is sooner. A failed, timed-out or
//    empty read is inconclusive: no change, retried after `retryMs`
//    (default 650 ms) until the deadline, then left to the resync.
//  - Derived edges (Lal round 3, F2): connection targets apply first;
//    parent/children then come from the MOUNTED connections only
//    (mapping.ts deriveFromMounted), so a stale connection the guard
//    rejected, or one a fetch failed to list, never moves an edge.
//  - Ordered: every pass takes a MountState sequence number before its
//    reads and applies through MountState's guard (state.ts) — an older
//    revision never replaces a newer one, whatever finished last. Passes
//    run one at a time, so a record is never reconciled concurrently.
//  - Dirty generation: a hint for a record already dirty bumps its
//    generation; a pass resolves a record only if no hint arrived while
//    its fetch was in flight — otherwise the record is re-checked.
//
// When is a dirty record resolved? A create hint: once the record
// fetches. An update hint: once the fetch shows a revision newer than the
// last one seen, once per update hint (two hinted updates need two newer
// revisions), and not older than the newest claimed stamp minus 1 s
// (hdk_crud's signal stamp is sys_time() taken after the commit, so it is
// at or above the stored action stamp; 1 s absorbs the gap). Neither the
// count nor the claim is trusted for data: every pass applies whatever
// newer data the fetch shows; they only decide when to stop polling, so
// a forged or skipped revision costs polling until the deadline, never a
// wrong mount. Delete hints produce no target (signals.ts header).

import { agentToDid } from "./agent";
import {
  deriveFromMounted,
  reexpandOutcome,
  toData,
  urlToHash,
  type Derived,
  type MapCtx,
} from "./mapping";
import { hintTargets, type FetchKind, type HintTarget } from "./signals";
import { MountState, type MountDelta, type SnapshotEntry } from "./state";

const CLAIM_TOLERANCE_US = 1_000_000;

export interface ReconcilerOpts {
  lang: string;
  state: MountState;
  /** a verified collection read (fetch_* through the zomes) */
  fetch: (kind: FetchKind) => Promise<any[]>;
  /** push a verified delta to the mount */
  emit: (delta: MountDelta) => void;
  /** a full resync: read everything, merge through the state, answer the
   *  delta (overflow fallback) */
  resync: (fence: ResyncFence) => Promise<MountDelta>;
  /** own agent key + AD4M DID (the own member's sameAs) */
  identity?: () => { ownAgent?: string; ad4mDid?: string };
  maxPending?: number;
  budgetMs?: number;
  retryMs?: number;
  fetchTimeoutMs?: number;
  /** host calls (collection reads) allowed outstanding until they SETTLE
   *  — a timed-out call still counts (default 9, one per collection) */
  maxOutstanding?: number;
  /** deadline for the overflow resync (default 30 000 ms) */
  overflowTimeoutMs?: number;
}

/** Handed to an overflow resync: `stale()` turns true once the worker
 *  stopped waiting for it — its read must then not be applied. */
export interface ResyncFence {
  stale(): boolean;
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;
const LIFETIME_BUDGETS = 3;

interface Dirty extends HintTarget {
  key: string;
  /** mounted revision when first hinted (address records) */
  lastRev: number;
  /** mounted data when first hinted (profiles: no revision) */
  baseData?: string;
  /** update hints not yet matched by a newer revision */
  updates: number;
  /** newest claimed stamp minus tolerance */
  want: number;
  gen: number;
  /** 0 until the worker is started */
  deadline: number;
  /** when the worker could first act on it: re-hints extend the deadline
   *  to at most firstAt + 3 budgets (Lal round 3, F3) */
  firstAt: number;
  nextAt: number;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return undefined;
}

const TIMED_OUT = Symbol("timed out");

export class Reconciler {
  readonly stats = {
    passes: 0,
    fetches: 0,
    resyncs: 0,
    resyncFailures: 0,
    dropped: 0,
    overflows: 0,
    expired: 0,
  };
  private readonly queue = new Map<string, Dirty>();
  private started = false;
  private overflowPending = false;
  /** hints may be dropped as covered by the owed resync — only until an
   *  attempt at it fails (F3: a hung resync must not swallow all work) */
  private dropCovered = false;
  /** MountState seq at the last hint the pending resync must cover */
  private overflowSeq = 0;
  private loop: Promise<void> | null = null;
  private readonly maxPending: number;
  private readonly budgetMs: number;
  private readonly retryMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly maxOutstanding: number;
  private readonly overflowTimeoutMs: number;
  /** collection reads started and not yet settled, with their read seq */
  private readonly calls = new Map<FetchKind, { p: Promise<unknown>; seq: number }>();
  /** the overflow resync started and not yet settled */
  private resyncCall: Promise<unknown> | null = null;
  private backoffMs = 0;
  private resyncNotBefore = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: ReconcilerOpts) {
    this.maxPending = Math.max(1, o.maxPending ?? 256);
    this.budgetMs = Math.max(1, o.budgetMs ?? 13000);
    this.retryMs = Math.max(0, o.retryMs ?? 650);
    this.fetchTimeoutMs = Math.max(1, o.fetchTimeoutMs ?? 10000);
    this.maxOutstanding = Math.max(1, o.maxOutstanding ?? 9);
    this.overflowTimeoutMs = Math.max(1, o.overflowTimeoutMs ?? 30000);
  }

  /** dirty records waiting for the worker */
  get pending(): number {
    return this.queue.size;
  }

  /** Begin acting on hints, after the first snapshot — whose read began
   *  at `readSeq`. Hints queued before stay dirty and are reconciled now
   *  (their deadlines start here): a change made while the first
   *  snapshot was reading is not lost until the resync. */
  start(readSeq?: number): void {
    if (this.started) return;
    this.started = true;
    if (readSeq !== undefined) this.coveredBy(readSeq);
    const now = Date.now();
    for (const d of this.queue.values()) {
      d.deadline = now + this.budgetMs;
      d.firstAt = now;
      d.nextAt = now;
    }
    this.kick();
  }

  /** A full read that began at `readSeq` completed: a pending overflow
   *  resync is redundant if that read began after every hint it was
   *  meant to cover. */
  coveredBy(readSeq: number): void {
    if (this.overflowPending && readSeq > this.overflowSeq) {
      this.overflowPending = false;
    }
  }

  /** Resolves once the worker has nothing left to do. */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  /** Mark the records a decoded signal names dirty. Never throws, never
   *  waits: the worker does the reading. */
  hint(decoded: any): void {
    let targets: HintTarget[];
    try {
      targets = hintTargets(decoded);
    } catch {
      return;
    }
    const now = Date.now();
    for (const t of targets) {
      const mountedAt = t.address ?? (t.class === "AcornProfile" ? `profile/${t.agent}` : null);
      const cur = mountedAt ? this.o.state.entries.get(mountedAt) : undefined;
      if (cur && cur.class !== t.class) continue; // bound to another class
      const key = t.address ? `${t.class} ${t.address}` : `${t.class} agent:${t.agent}`;
      const claimed = t.claimedAt !== undefined ? t.claimedAt - CLAIM_TOLERANCE_US : -Infinity;
      const d = this.queue.get(key);
      if (d) {
        d.gen++;
        if (t.create) d.create = true;
        else d.updates++;
        d.want = Math.max(d.want, claimed);
        d.nextAt = now;
        if (this.started) {
          d.deadline = Math.min(now + this.budgetMs, d.firstAt + LIFETIME_BUDGETS * this.budgetMs);
        }
        continue;
      }
      if (this.overflowPending && this.dropCovered) {
        // the pending resync covers it, if its read begins after this
        this.overflowSeq = this.o.state.beginRead();
        continue;
      }
      if (this.queue.size >= this.maxPending) {
        if (!this.overflowPending) {
          this.queue.clear();
          this.overflowPending = true;
          this.dropCovered = true;
          this.overflowSeq = this.o.state.beginRead();
          this.stats.overflows++;
        } else {
          // a resync is owed but failed/blocked: keep working the queue we
          // have rather than trading it for a read that may never come
          this.stats.dropped++;
        }
        continue;
      }
      this.queue.set(key, {
        ...t,
        key,
        lastRev: num(cur?.data?.recordUpdatedAt) ?? -Infinity,
        baseData: cur ? JSON.stringify(cur.data) : undefined,
        updates: t.create ? 0 : 1,
        want: claimed,
        gen: 0,
        deadline: this.started ? now + this.budgetMs : 0,
        firstAt: now,
        nextAt: now,
      });
    }
    this.kick();
  }

  /** may the overflow resync start now? one at a time, after backoff */
  private resyncRunnable(): boolean {
    return this.overflowPending && !this.resyncCall && Date.now() >= this.resyncNotBefore;
  }

  private kick(): void {
    if (!this.started || this.loop) return;
    if (!this.resyncRunnable() && this.queue.size === 0) {
      // only a blocked resync is left: wake when its backoff ends (an
      // in-flight one kicks us when it settles)
      if (this.overflowPending && !this.resyncCall && !this.wakeTimer) {
        this.wakeTimer = setTimeout(() => {
          this.wakeTimer = null;
          this.kick();
        }, Math.max(1, this.resyncNotBefore - Date.now()));
        // a retry chain alone must not keep a host process alive
        (this.wakeTimer as any)?.unref?.();
      }
      return;
    }
    this.loop = this.run().finally(() => {
      this.loop = null;
      this.kick(); // work that arrived as the loop was exiting
    });
  }

  // The overflow fallback (F3): deadlined at overflowTimeoutMs; a read
  // that misses it is fenced (its result is neither applied — the resync
  // checks the fence — nor emitted), retried after an exponential backoff,
  // and no second resync starts until the first has SETTLED.
  private async overflowResync(): Promise<void> {
    // cleared BEFORE the read: hints from here on are queued again
    this.overflowPending = false;
    this.stats.resyncs++;
    let stale = false;
    const fence: ResyncFence = { stale: () => stale };
    let ok = false;
    const call = Promise.resolve()
      .then(() => this.o.resync(fence))
      .then(
        (d) => {
          if (stale) return;
          ok = true;
          if (d.changed.length || d.removed.length) this.o.emit(d);
        },
        (e) => {
          if (!stale) console.error("acorn reconcile: overflow resync failed:", e);
        }
      );
    this.resyncCall = call;
    call.finally(() => {
      this.resyncCall = null;
      this.kick();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      call,
      new Promise<void>((r) => {
        timer = setTimeout(r, this.overflowTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (ok) {
      this.backoffMs = 0;
      return;
    }
    stale = true;
    this.dropCovered = false;
    this.stats.resyncFailures++;
    this.backoffMs = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, this.backoffMs * 2));
    this.resyncNotBefore = Date.now() + this.backoffMs;
    this.overflowPending = true; // still owed
  }

  private async run(): Promise<void> {
    for (;;) {
      if (this.resyncRunnable()) {
        await this.overflowResync();
        continue;
      }
      if (this.queue.size === 0) return;
      const now = Date.now();
      for (const d of [...this.queue.values()]) {
        if (d.deadline <= now) {
          this.queue.delete(d.key);
          this.stats.expired++;
        }
      }
      if (this.queue.size === 0) return;
      const due = [...this.queue.values()].filter((d) => d.nextAt <= now);
      if (due.length === 0) {
        let wake = Infinity;
        for (const d of this.queue.values()) wake = Math.min(wake, d.nextAt, d.deadline);
        await new Promise((r) => setTimeout(r, Math.max(1, wake - now)));
        continue;
      }
      await this.pass(due, now);
    }
  }

  /** collection reads started and not yet settled */
  get outstanding(): number {
    return this.calls.size;
  }

  // One collection read, bounded (F3): a read of that collection still
  // outstanding from an earlier pass (timed out but not settled) is
  // awaited again instead of starting another host call; no new call
  // starts while maxOutstanding are unsettled. Answers the rows (null =
  // inconclusive) and the seq of the read actually used.
  private async fetchBounded(
    kind: FetchKind,
    ms: number
  ): Promise<{ rows: any[] | null; seq: number }> {
    let call = this.calls.get(kind);
    if (!call) {
      if (this.calls.size >= this.maxOutstanding) return { rows: null, seq: 0 };
      this.stats.fetches++;
      const seq = this.o.state.beginRead();
      const p = Promise.resolve().then(() => this.o.fetch(kind));
      const c = { p, seq };
      this.calls.set(kind, c);
      p.then(
        () => {},
        () => {}
      ).finally(() => {
        if (this.calls.get(kind) === c) this.calls.delete(kind);
      });
      call = c;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        call.p,
        new Promise<typeof TIMED_OUT>((r) => {
          timer = setTimeout(() => r(TIMED_OUT), ms);
        }),
      ]);
      if (res === TIMED_OUT) return { rows: null, seq: call.seq };
      const rows = Array.isArray(res) ? res : res == null ? [] : [res];
      return { rows, seq: call.seq };
    } catch {
      return { rows: null, seq: call.seq }; // inconclusive
    } finally {
      clearTimeout(timer);
    }
  }

  private async pass(due: Dirty[], now: number): Promise<void> {
    this.stats.passes++;
    const kinds = new Set<FetchKind>(due.map((d) => d.kind));
    if (due.some((d) => d.class === "AcornConnection")) kinds.add("outcomes");
    const gens = new Map(due.map((d) => [d, d.gen]));
    const latest = Math.max(...due.map((d) => d.deadline));
    const ms = Math.max(1, Math.min(this.fetchTimeoutMs, latest - now));

    // every read is applied at the OLDEST start seq among this pass's
    // reads (a reused read may have started passes ago): older can only
    // lose ties in the guard, never wrongly win them
    const got = await Promise.all(
      [...kinds].map(async (k) => [k, await this.fetchBounded(k, ms)] as const)
    );
    const rows = new Map<FetchKind, any[] | null>(got.map(([k, r]) => [k, r.rows]));
    const seqs = got.filter(([, r]) => r.rows).map(([, r]) => r.seq);
    const seq = seqs.length ? Math.min(...seqs) : this.o.state.beginRead();

    // Lal round 3, F2: connections first, through the guard; then every
    // derived edge comes from the MOUNTED connections — a stale connection
    // the guard rejected, or one a read failed to list, never moves an edge.
    const changed = new Map<string, SnapshotEntry>();
    const done = new Map<Dirty, boolean>();
    const ends = new Set<string>();
    const run = (d: Dirty, f: () => boolean) => {
      try {
        done.set(d, f());
      } catch (e) {
        console.error("acorn reconcile:", e);
        done.set(d, false);
      }
    };
    for (const d of due) {
      if (d.class === "AcornConnection") run(d, () => this.checkConnection(d, rows, seq, changed, ends));
    }
    const derived = deriveFromMounted(this.o.state.entries, this.o.lang);
    for (const d of due) {
      if (d.class !== "AcornConnection") run(d, () => this.check(d, rows, derived, seq, changed));
    }
    const outs = rows.get("outcomes") ?? null;
    for (const end of ends) this.expand(end, outs, derived, seq, changed);

    const after = Date.now();
    for (const d of due) {
      if (this.queue.get(d.key) !== d) continue;
      if (done.get(d) && d.gen === gens.get(d)) this.queue.delete(d.key);
      else d.nextAt = d.gen !== gens.get(d) ? after : after + this.retryMs;
    }
    if (changed.size) this.o.emit({ changed: [...changed.values()], removed: [] });
  }

  // A hinted connection: applied through the guard; its old (mounted) and
  // fetched endpoints are re-expanded after the pass derives edges.
  private checkConnection(
    d: Dirty,
    rows: Map<FetchKind, any[] | null>,
    seq: number,
    changed: Map<string, SnapshotEntry>,
    ends: Set<string>
  ): boolean {
    const list = rows.get("connections");
    if (!list) return false; // inconclusive read
    const addr = d.address!;
    const rec = list.find((r: any) => r?.actionHash === addr);
    if (!rec) return false;
    const cur = this.o.state.entries.get(addr);
    if (cur && cur.class !== "AcornConnection") return true; // not ours to touch
    for (const u of [cur?.data.parent, cur?.data.child]) {
      if (u != null) ends.add(urlToHash(u, this.o.lang));
    }
    for (const h of [rec.entry?.parentActionHash, rec.entry?.childActionHash]) {
      if (typeof h === "string" && h) ends.add(h);
    }
    this.put(
      { class: "AcornConnection", address: addr, data: toData("AcornConnection", rec, this.mapCtx(null)) },
      seq,
      changed
    );
    return this.resolvedAt(d, rec);
  }

  // Revision bookkeeping for a fetched record: true when the dirty record
  // can stop polling (see the header).
  private resolvedAt(d: Dirty, rec: any): boolean {
    const rev = num(rec.updatedAt);
    if (rev === undefined) return d.updates <= 0;
    if (rev > d.lastRev) {
      // the first sighting of a hinted create is the create, not an update
      if (!(d.create && d.lastRev === -Infinity)) d.updates = Math.max(0, d.updates - 1);
      d.lastRev = rev;
    }
    return d.updates <= 0 && rev >= d.want;
  }

  private mapCtx(derived: Derived | null): MapCtx {
    const lang = this.o.lang;
    const id = this.o.identity?.() ?? {};
    return {
      lang,
      hashToUrl: (h) => `${lang}://${h}`,
      agentToDid,
      ownAgent: id.ownAgent,
      ad4mDid: id.ad4mDid,
      derived: derived ?? undefined,
    };
  }

  private put(e: SnapshotEntry, seq: number, changed: Map<string, SnapshotEntry>) {
    if (this.o.state.apply(e, seq)) changed.set(e.address, e);
  }

  // One dirty record against this pass's reads; true when resolved.
  private check(
    d: Dirty,
    rows: Map<FetchKind, any[] | null>,
    derived: Derived | null,
    seq: number,
    changed: Map<string, SnapshotEntry>
  ): boolean {
    const list = rows.get(d.kind);
    if (!list) return false; // inconclusive read
    const state = this.o.state;
    const mctx = this.mapCtx(derived);

    if (d.class === "AcornMember") {
      const rec = list.find((r: any) => (r?.entry ?? r)?.agentPubKey === d.agent);
      if (typeof rec?.actionHash !== "string") return false;
      const cur = state.entries.get(rec.actionHash);
      if (cur && cur.class !== "AcornMember") return true; // not ours to touch
      this.put(
        { class: "AcornMember", address: rec.actionHash, data: toData("AcornMember", rec, mctx) },
        seq,
        changed
      );
      return true;
    }

    if (d.class === "AcornProfile") {
      const rec = list.find((p: any) => p?.agentPubKey === d.agent);
      if (!rec) return false;
      const e = {
        class: "AcornProfile",
        address: `profile/${d.agent}`,
        data: toData("AcornProfile", rec, mctx),
      };
      this.put(e, seq, changed);
      // no revision on a bare Profile: an update resolves once the
      // fetched profile differs from what was mounted when hinted
      return d.create || JSON.stringify(e.data) !== d.baseData;
    }

    const addr = d.address!;
    const rec = list.find((r: any) => r?.actionHash === addr);
    if (!rec) return false;
    const cur = state.entries.get(addr);
    if (cur && cur.class !== d.class) return true; // not ours to touch
    this.put({ class: d.class, address: addr, data: toData(d.class, rec, mctx) }, seq, changed);
    return this.resolvedAt(d, rec);
  }

  // Re-expand one outcome's parent/children against the mount-derived
  // edges: its MOUNTED data when mounted (a fetched copy could be an
  // older revision), else the fetched record when the pass read one.
  private expand(
    addr: string,
    outs: any[] | null,
    derived: Derived,
    seq: number,
    changed: Map<string, SnapshotEntry>
  ) {
    const cur = this.o.state.entries.get(addr);
    if (cur) {
      if (cur.class !== "AcornOutcome") return;
      this.put(reexpandOutcome(addr, cur.data, derived, this.o.lang), seq, changed);
      return;
    }
    const rec = outs?.find((r: any) => r?.actionHash === addr);
    if (rec) {
      this.put(
        {
          class: "AcornOutcome",
          address: addr,
          data: toData("AcornOutcome", rec, this.mapCtx(derived)),
        },
        seq,
        changed
      );
    }
  }
}

// ---------------------------------------------------------------------------
// one hint, to completion — the unit-test (and B4-compatible) view
// ---------------------------------------------------------------------------

export interface SignalCtx {
  lang: string;
  /** read view of the mount: address -> {class, data} */
  snapshot: ReadonlyMap<string, { class: string; data: Record<string, unknown> }>;
  /** the verified read path (fetch_* calls) */
  fetch: (kind: FetchKind) => Promise<any[]>;
  ownAgent?: string;
  ad4mDid?: string;
  /** budget = confirmTries × confirmDelayMs of wall clock; retry pause
   *  confirmDelayMs (defaults 20 × 650 ms) */
  confirmTries?: number;
  confirmDelayMs?: number;
}

/** Run one decoded signal through a private Reconciler over a copy of
 *  `ctx.snapshot`; the verified changes it made, or null. */
export async function signalToDelta(
  decoded: any,
  ctx: SignalCtx
): Promise<MountDelta | null> {
  if (!ctx || typeof ctx.fetch !== "function") return null;
  const tries = Math.max(1, ctx.confirmTries ?? 20);
  const delay = Math.max(0, ctx.confirmDelayMs ?? 650);
  const out = new Map<string, SnapshotEntry>();
  const r = new Reconciler({
    lang: ctx.lang,
    state: new MountState(new Map(ctx.snapshot)),
    fetch: ctx.fetch,
    emit: (d) => d.changed.forEach((e) => out.set(e.address, e)),
    resync: async () => ({ changed: [], removed: [] }),
    identity: () => ({ ownAgent: ctx.ownAgent, ad4mDid: ctx.ad4mDid }),
    budgetMs: Math.max(1, tries * delay),
    retryMs: delay,
  });
  r.start();
  r.hint(decoded);
  await r.idle();
  return out.size ? { changed: [...out.values()], removed: [] } : null;
}
