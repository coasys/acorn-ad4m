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
  resync: () => Promise<MountDelta>;
  /** own agent key + AD4M DID (the own member's sameAs) */
  identity?: () => { ownAgent?: string; ad4mDid?: string };
  maxPending?: number;
  budgetMs?: number;
  retryMs?: number;
  fetchTimeoutMs?: number;
}

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
  nextAt: number;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return undefined;
}

const TIMED_OUT = Symbol("timed out");

export class Reconciler {
  readonly stats = { passes: 0, fetches: 0, resyncs: 0, overflows: 0, expired: 0 };
  private readonly queue = new Map<string, Dirty>();
  private started = false;
  private overflowPending = false;
  /** MountState seq at the last hint the pending resync must cover */
  private overflowSeq = 0;
  private loop: Promise<void> | null = null;
  private readonly maxPending: number;
  private readonly budgetMs: number;
  private readonly retryMs: number;
  private readonly fetchTimeoutMs: number;

  constructor(private readonly o: ReconcilerOpts) {
    this.maxPending = Math.max(1, o.maxPending ?? 256);
    this.budgetMs = Math.max(1, o.budgetMs ?? 13000);
    this.retryMs = Math.max(0, o.retryMs ?? 650);
    this.fetchTimeoutMs = Math.max(1, o.fetchTimeoutMs ?? 10000);
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
        if (this.started) d.deadline = now + this.budgetMs;
        continue;
      }
      if (this.overflowPending) {
        // the pending resync covers it, if its read begins after this
        this.overflowSeq = this.o.state.beginRead();
        continue;
      }
      if (this.queue.size >= this.maxPending) {
        this.queue.clear();
        this.overflowPending = true;
        this.overflowSeq = this.o.state.beginRead();
        this.stats.overflows++;
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
        nextAt: now,
      });
    }
    this.kick();
  }

  private kick(): void {
    if (!this.started || this.loop) return;
    if (!this.overflowPending && this.queue.size === 0) return;
    this.loop = this.run().finally(() => {
      this.loop = null;
      this.kick(); // work that arrived as the loop was exiting
    });
  }

  private async run(): Promise<void> {
    for (;;) {
      if (this.overflowPending) {
        // cleared BEFORE the read: hints from here on are queued again
        this.overflowPending = false;
        this.stats.resyncs++;
        try {
          const d = await this.o.resync();
          if (d.changed.length || d.removed.length) this.o.emit(d);
        } catch (e) {
          console.error("acorn reconcile: overflow resync failed:", e);
        }
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

  private async fetchBounded(kind: FetchKind, ms: number): Promise<any[] | null> {
    this.stats.fetches++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        this.o.fetch(kind),
        new Promise<typeof TIMED_OUT>((r) => {
          timer = setTimeout(() => r(TIMED_OUT), ms);
        }),
      ]);
      if (res === TIMED_OUT) return null;
      return Array.isArray(res) ? res : res == null ? [] : [res];
    } catch {
      return null; // inconclusive
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

    const seq = this.o.state.beginRead();
    const rows = new Map<FetchKind, any[] | null>(
      await Promise.all(
        [...kinds].map(async (k) => [k, await this.fetchBounded(k, ms)] as const)
      )
    );

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
