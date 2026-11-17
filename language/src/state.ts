// Mounted state shared by the read and write paths. This module is pure —
// snapshot.ts does the zome calls; keeping the state here lets write.ts and
// the unit tests run without the `ad4m:host` import.

/** One mounted record: its class, its mount address, its mapped data. */
export interface SnapshotEntry {
  class: string;
  address: string;
  data: Record<string, unknown>;
}

/** Identity the snapshot needs beyond `lang`: the own agent key (whose
 *  member gets `sameAs`) and the AD4M DID it points to (Correction 15). */
export interface SnapshotIdentity {
  ownAgent?: string;
  ad4mDid?: string;
}

/** address -> {class, data} of the last snapshot `mountSnapshot` returned. */
export const lastSnapshot = new Map<
  string,
  { class: string; data: Record<string, unknown> }
>();

/** What a language pushes (`emitSignal({ mountDelta })`) or a write
 *  interaction answers: changed records in full, removed addresses. */
export interface MountDelta {
  address?: string;
  changed: SnapshotEntry[];
  removed: string[];
}

// A record's revision: WireRecord.updatedAt (the latest update action's
// timestamp, µs), mounted as `recordUpdatedAt`. Profiles (bare, no
// WireRecord) have none.
function revOf(data: Record<string, unknown>): number | undefined {
  const v = data?.recordUpdatedAt;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return undefined;
}

const MAX_TOMBSTONES = 10000;

function sameData(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The mounted records plus what the apply-time guard needs (Lal round 2,
 * P2 #2). Every read that can change the mount — a signal-hint fetch, the
 * full resync, a write path's snapshot — takes a sequence number from
 * `beginRead()` BEFORE it reads, and applies through `apply` /
 * `applySnapshot`, which decide when the result lands, against what is
 * mounted THEN:
 *
 *  - class binding: an address mounted as class Y never takes class X;
 *  - revision order: a lower `recordUpdatedAt` never replaces a higher
 *    one, whichever read finished last;
 *  - equal revision (or no revision — profiles): the read that STARTED
 *    later wins, so derived fields (parent/children) never regress to an
 *    older connection view;
 *  - tombstones: a removal records its sequence number; a read that began
 *    before it cannot bring the record back (one that began after can —
 *    it is fresh evidence of a live record).
 *
 * Callers are synchronous between check and set, so the JS event loop
 * serializes applies per record.
 */
export class MountState {
  private counter = 0;
  private readonly seqOf = new Map<string, number>();
  private readonly tombs = new Map<string, number>();

  constructor(
    readonly entries: Map<
      string,
      { class: string; data: Record<string, unknown> }
    > = new Map()
  ) {}

  /** A fresh sequence number; take it before the read starts. */
  beginRead(): number {
    return ++this.counter;
  }

  /** Apply one fetched record read at `seq`; true when the mount changed. */
  apply(e: SnapshotEntry, seq: number): boolean {
    const cur = this.entries.get(e.address);
    if (cur) {
      if (cur.class !== e.class) return false;
      const curSeq = this.seqOf.get(e.address) ?? 0;
      const a = revOf(cur.data);
      const b = revOf(e.data);
      if (a !== undefined && b !== undefined && b !== a) {
        if (b < a) return false;
      } else if (curSeq > seq) {
        return false;
      }
      if (sameData(cur.data, e.data)) {
        if (seq > curSeq) this.seqOf.set(e.address, seq);
        return false;
      }
    } else {
      const tomb = this.tombs.get(e.address);
      if (tomb !== undefined && tomb > seq) return false;
    }
    this.entries.set(e.address, { class: e.class, data: e.data });
    this.seqOf.set(e.address, seq);
    this.tombs.delete(e.address);
    return true;
  }

  /** `apply` each; the entries that changed the mount, as applied. */
  applyChanged(changed: SnapshotEntry[], seq: number): SnapshotEntry[] {
    return changed.filter((e) => this.apply(e, seq));
  }

  /**
   * A FULL read of every collection, begun at `seq` — the periodic resync
   * and the write paths' snapshots. Fetched records apply through the
   * guard; a mounted record absent from the read is removed unless it was
   * applied by a read that began after this one. This is the only path
   * that removes (see signals.ts on why a hint cannot).
   */
  applySnapshot(read: SnapshotEntry[], seq: number): MountDelta {
    const changed: SnapshotEntry[] = [];
    const seen = new Set<string>();
    for (const e of read) {
      seen.add(e.address);
      if (this.apply(e, seq)) changed.push(e);
    }
    const removed: string[] = [];
    for (const addr of [...this.entries.keys()]) {
      if (seen.has(addr)) continue;
      if ((this.seqOf.get(addr) ?? 0) > seq) continue;
      this.entries.delete(addr);
      this.seqOf.delete(addr);
      this.tombs.set(addr, ++this.counter);
      if (this.tombs.size > MAX_TOMBSTONES) {
        // oldest first (insertion order); a read older than the evicted
        // tombstone is long finished — the worker's reads are deadlined.
        this.tombs.delete(this.tombs.keys().next().value!);
      }
      removed.push(addr);
    }
    return { changed, removed };
  }

  /** Every mounted record, as snapshot entries. */
  list(): SnapshotEntry[] {
    return [...this.entries].map(([address, e]) => ({
      class: e.class,
      address,
      data: e.data,
    }));
  }
}

/** The language's one mount state, over `lastSnapshot`. */
export const mountState = new MountState(lastSnapshot);
