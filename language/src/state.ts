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
