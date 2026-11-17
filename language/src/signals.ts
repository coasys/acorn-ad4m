// Acorn remote signals -> mount deltas (design §1.5, §4.3; step B4).
//
// `handleHolochainSignal` receives `{ cell_id, zome_name, payload }` where
// `payload` is a Uint8Array of msgpack — one `decode` gives the adjacently
// tagged envelope `{ signalType, data }` (verified on the rig, see
// test/fixtures/raw-signal.md). `data` is the per-signal struct:
//
//   CRUD signals   { entryType, action: "create"|"update"|"delete",
//                    data: WireRecord | ActionHashB64 }
//   OutcomeWithConnection  { entryType, action, data: { outcome, maybeConnection } }
//   DeleteOutcomeFully     { entryType, action, data: DeleteOutcomeFullyResponse }
//   Member         { entry_type(!), action, data: Member }   (bare Member)
//   Agent (profiles)       { entryType, action, data: WireRecord<Profile> | hash }
//   RealtimeInfo / EditingOutcome / OutcomeVote — not data: null
//
// `signalToDelta` is pure: it reads the last snapshot (through `ctx`) to
// re-expand outcomes whose derived parent/children edges changed and to
// address records a signal cannot name (member entries carry no hash).
// Applying the returned delta to the snapshot map is the caller's job.

import { decode } from "@msgpack/msgpack";
import { agentToDid } from "./agent";
import { toData, urlToHash, type Derived, type MapCtx } from "./mapping";
import type { SnapshotEntry } from "./snapshot";

export interface MountDelta {
  address?: string;
  changed: SnapshotEntry[];
  removed: string[];
}

export interface SignalCtx {
  lang: string;
  /** read view of `lastSnapshot`: address -> {class, data} */
  snapshot: ReadonlyMap<string, { class: string; data: Record<string, unknown> }>;
}

// The CRUD signal variants (projects zome SignalType) that map one-to-one
// onto mounted classes. OutcomeVote is deliberately absent: not mounted.
const CLASS_FOR: Record<string, string> = {
  Outcome: "AcornOutcome",
  Connection: "AcornConnection",
  EntryPoint: "AcornEntryPoint",
  OutcomeComment: "AcornOutcomeComment",
  OutcomeMember: "AcornOutcomeMember",
  Tag: "AcornTag",
  ProjectMeta: "AcornProjectMeta",
};

// MemberSignal has no serde rename — `entry_type` snake_case; every other
// signal struct writes `entryType` (Correction 5). Removing the
// `?? s?.entry_type` fallback must turn the member unit test red.
function entryTypeOf(s: any): string | undefined {
  return s?.entryType ?? s?.entry_type;
}

/**
 * Decode the raw `signal.payload` the executor hands a flat language: a
 * Uint8Array of msgpack (the normal case), a `{__binary:[...]}` marker that
 * missed conversion, or an already-decoded envelope. Returns null on
 * anything that is not a `{signalType, data}` object.
 */
export function decodeSignalEnvelope(payload: any): any | null {
  let p = payload;
  if (p instanceof Uint8Array) {
    try {
      p = decode(p);
    } catch {
      return null;
    }
  } else if (p && typeof p === "object" && Array.isArray(p.__binary)) {
    try {
      p = decode(new Uint8Array(p.__binary));
    } catch {
      return null;
    }
  }
  if (!p || typeof p !== "object" || typeof p.signalType !== "string") {
    return null;
  }
  return p;
}

function mapCtx(ctx: SignalCtx, derived: Derived): MapCtx {
  return {
    lang: ctx.lang,
    hashToUrl: (h) => `${ctx.lang}://${h}`,
    agentToDid,
    derived,
  };
}

interface ConnEdge {
  parent: string;
  child: string;
}

/** connAddress -> {parent, child} (hashes) of every connection the last
 *  snapshot holds, in snapshot order. */
function snapshotConns(ctx: SignalCtx): Map<string, ConnEdge> {
  const out = new Map<string, ConnEdge>();
  for (const [addr, e] of ctx.snapshot) {
    if (e.class !== "AcornConnection") continue;
    const parent = e.data.parent != null ? urlToHash(e.data.parent, ctx.lang) : null;
    const child = e.data.child != null ? urlToHash(e.data.child, ctx.lang) : null;
    if (parent && child) out.set(addr, { parent, child });
  }
  return out;
}

function derivedFrom(conns: Map<string, ConnEdge>): Derived {
  const parents = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const { parent, child } of conns.values()) {
    parents.set(child, parent);
    const list = children.get(parent) ?? [];
    list.push(child);
    children.set(parent, list);
  }
  return { parents, children };
}

// Re-expand one outcome's mounted data with recomputed derived edges —
// same semantics as toData's parent/children, applied to snapshot data
// (the WireRecord itself is not kept).
function reexpandOutcome(
  addr: string,
  data: Record<string, unknown>,
  derived: Derived,
  ctx: SignalCtx
): SnapshotEntry {
  const out = { ...data };
  const parent = derived.parents.get(addr);
  if (parent) out.parent = `${ctx.lang}://${parent}`;
  else delete out.parent;
  const children = derived.children.get(addr);
  if (children?.length) out.children = children.map((h) => `${ctx.lang}://${h}`);
  else delete out.children;
  return { class: "AcornOutcome", address: addr, data: out };
}

// The outcomes whose derived edges a connection change touches; missing
// ones are skipped — the resync picks them up.
function expandTouched(
  addrs: Iterable<string | null | undefined>,
  derived: Derived,
  ctx: SignalCtx,
  changed: SnapshotEntry[]
) {
  for (const addr of addrs) {
    if (!addr) continue;
    const hit = ctx.snapshot.get(addr);
    if (hit?.class === "AcornOutcome") {
      changed.push(reexpandOutcome(addr, hit.data, derived, ctx));
    }
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export function signalToDelta(decoded: any, ctx: SignalCtx): MountDelta | null {
  if (!decoded || typeof decoded !== "object") return null;
  const signalType: unknown = decoded.signalType;
  const payload = decoded.data;
  if (typeof signalType !== "string" || payload == null || typeof payload !== "object") {
    return null;
  }
  const action: unknown = payload.action;
  const inner = payload.data;

  // ---- custom structs -----------------------------------------------

  if (signalType === "OutcomeWithConnection") {
    const rec = inner?.outcome;
    const addr = str(rec?.actionHash);
    if (!addr) return null;
    const conns = snapshotConns(ctx);
    const conn = inner?.maybeConnection;
    const connHash = str(conn?.actionHash);
    if (connHash) {
      conns.set(connHash, {
        parent: conn.entry?.parentActionHash,
        child: conn.entry?.childActionHash,
      });
    }
    const derived = derivedFrom(conns);
    const mctx = mapCtx(ctx, derived);
    const changed: SnapshotEntry[] = [
      { class: "AcornOutcome", address: addr, data: toData("AcornOutcome", rec, mctx) },
    ];
    if (connHash) {
      changed.push({
        class: "AcornConnection",
        address: connHash,
        data: toData("AcornConnection", conn, mctx),
      });
      expandTouched(
        [conn.entry?.parentActionHash, conn.entry?.childActionHash].filter(
          (a) => a !== addr
        ),
        derived,
        ctx,
        changed
      );
    }
    return { changed, removed: [] };
  }

  if (signalType === "DeleteOutcomeFully") {
    const outcome = str(inner?.outcomeActionHash);
    if (!outcome) return null;
    const conns = snapshotConns(ctx);
    const touched = new Set<string>();
    for (const h of inner.deletedConnections ?? []) {
      const c = conns.get(h);
      if (c) {
        touched.add(c.parent);
        touched.add(c.child);
      }
      conns.delete(h);
    }
    touched.delete(outcome);
    const removed = [
      outcome,
      ...(inner.deletedConnections ?? []),
      ...(inner.deletedOutcomeMembers ?? []),
      ...(inner.deletedOutcomeComments ?? []),
      ...(inner.deletedOutcomeVotes ?? []),
      ...(inner.deletedEntryPoints ?? []),
    ].filter((h): h is string => typeof h === "string");
    const derived = derivedFrom(conns);
    const changed: SnapshotEntry[] = [];
    expandTouched(touched, derived, ctx, changed);
    return { changed, removed };
  }

  if (signalType === "Member") {
    // MemberSignal carries a bare Member (no hash): find the member's
    // mounted address in the snapshot; a new member's is not in the
    // signal, so it waits for the resync.
    if (entryTypeOf(payload) !== "member") return null;
    const key = str(inner?.agentPubKey);
    if (!key) return null;
    const did = agentToDid(key);
    for (const [addr, e] of ctx.snapshot) {
      if (e.class === "AcornMember" && e.data.agent === did) {
        return { changed: [{ class: "AcornMember", address: addr, data: { ...e.data } }], removed: [] };
      }
    }
    return null;
  }

  if (signalType === "Agent") {
    // profiles zome's own SignalType; mounted at profile/<AgentPubKeyB64>.
    if (action === "create" || action === "update") {
      const profile = inner?.entry ?? inner;
      const key = str(profile?.agentPubKey);
      if (!key) return null;
      const mctx = mapCtx(ctx, derivedFrom(snapshotConns(ctx)));
      return {
        changed: [
          {
            class: "AcornProfile",
            address: `profile/${key}`,
            data: toData("AcornProfile", profile, mctx),
          },
        ],
        removed: [],
      };
    }
    // a delete carries the profile's create actionHash, which is not the
    // mounted address and cannot be resolved — left to the resync.
    return null;
  }

  // ---- CRUD signals ---------------------------------------------------

  const className = CLASS_FOR[signalType];
  if (!className) return null; // RealtimeInfo, EditingOutcome, OutcomeVote

  if (action === "delete") {
    const hash = str(inner) ?? str(inner?.actionHash);
    if (!hash) return null;
    if (className === "AcornConnection") {
      // the record is gone from the signal; its ends come from the snapshot
      const conns = snapshotConns(ctx);
      const old = conns.get(hash);
      conns.delete(hash);
      const derived = derivedFrom(conns);
      const changed: SnapshotEntry[] = [];
      expandTouched([old?.parent, old?.child], derived, ctx, changed);
      return { changed, removed: [hash] };
    }
    return { changed: [], removed: [hash] };
  }

  if (action === "create" || action === "update") {
    const rec = inner;
    const addr = str(rec?.actionHash);
    if (!addr) return null;
    const conns = snapshotConns(ctx);
    let touched: (string | null | undefined)[] = [];
    if (className === "AcornConnection") {
      const old = conns.get(addr);
      const parent = str(rec.entry?.parentActionHash);
      const child = str(rec.entry?.childActionHash);
      if (parent && child) conns.set(addr, { parent, child });
      touched = [old?.parent, old?.child, parent, child];
    }
    const derived = derivedFrom(conns);
    const mctx = mapCtx(ctx, derived);
    const changed: SnapshotEntry[] = [
      { class: className, address: addr, data: toData(className, rec, mctx) },
    ];
    expandTouched(new Set(touched), derived, ctx, changed);
    return { changed, removed: [] };
  }

  return null;
}
