// Host-call pool (Lal round 3 F3, round 4 P2-2). A host call (zome read)
// cannot be cancelled: a caller that stops waiting leaves it running. So
// every collection read — the signal worker's network reads and every
// full snapshot's local reads — goes through one pool that:
//
//  - keeps a call counted until it SETTLES (resolve or reject), whoever
//    stopped waiting for it;
//  - dedups by key: while a call for a key is unsettled, a new read of
//    that key awaits the same call instead of starting another;
//  - caps unsettled calls at `max`; above it `run` answers null and the
//    caller treats the read as failed/inconclusive.
//
// Each call records the MountState seq and wall-clock time taken when it
// STARTED, so a caller that reuses an older call orders its result by
// when that read began, not when it asked.

export interface PooledCall<T> {
  p: Promise<T>;
  /** read seq taken when the underlying call started */
  seq: number;
  /** Date.now() when the underlying call started */
  startedAt: number;
  /** true when an earlier caller's unsettled call was reused */
  reused: boolean;
}

export class CallPool {
  private readonly calls = new Map<string, PooledCall<unknown>>();

  constructor(readonly max: number) {}

  /** unsettled calls */
  get size(): number {
    return this.calls.size;
  }

  /** The unsettled call for `key`, or a new one from `start` (null when
   *  the pool is full). `seq` gives the read seq for a new call. */
  run<T>(key: string, start: () => Promise<T>, seq: () => number): PooledCall<T> | null {
    const cur = this.calls.get(key) as PooledCall<T> | undefined;
    if (cur) return { ...cur, reused: true };
    if (this.calls.size >= this.max) return null;
    const call: PooledCall<T> = {
      p: Promise.resolve().then(start),
      seq: seq(),
      startedAt: Date.now(),
      reused: false,
    };
    this.calls.set(key, call);
    call.p.then(
      () => {},
      () => {}
    ).finally(() => {
      if (this.calls.get(key) === call) this.calls.delete(key);
    });
    return call;
  }
}

/** The language's one pool: 9 network (worker) + 9 local (snapshot)
 *  collection reads at most. */
export const sharedPool = new CallPool(18);
