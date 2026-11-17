// Acorn remote signals -> invalidation hints (design §1.5, §4.3; steps
// B4, B6, B7).
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
// A signal is ONLY an invalidation hint (B6, Lal P1): `hintTargets` turns
// it into the records to re-check — class + address (or agent key for
// members/profiles), whether it claims a create, and the claimed stamp.
// The Reconciler (reconcile.ts) re-reads those through the zomes (the
// same fetch_* the snapshot uses) and mounts only what it fetched. Signal
// fields never reach the mount.
//
// Deletion (Lal round 2, P1): a hint NEVER removes a mounted record. A
// removal would need proof of a tombstone, and the stock zomes expose no
// read that gives one: every fetch_* goes through hdk_crud's
// get_latest_for_entry, which answers None alike for
// EntryDhtStatus::Dead, for details not (yet) gossiped to us and — in
// fetch_links/Specific — for a per-record error it silently drops. No
// zome exposes get_details or a record status. So "absent from the list"
// is inconclusive, delete hints produce no target at all, and the only
// path that removes is the full resync (MountState.applySnapshot). Every
// target is bound to the class it is mounted as: a hint about class X
// never changes a record mounted as class Y.

import { decode } from "@msgpack/msgpack";

// The collections a signal's verification can need — the same fetch_* zome
// reads takeSnapshot uses (zomes.md). `input` is the ZomeFnInput's inner
// field; the caller wraps it as `{ input, local: true }`.
export type FetchKind =
  | "outcomes"
  | "connections"
  | "entryPoints"
  | "comments"
  | "outcomeMembers"
  | "tags"
  | "projectMetas"
  | "members"
  | "profiles";

export const FETCH_SPEC: Record<
  FetchKind,
  { zome: string; fn: string; input: unknown }
> = {
  outcomes: { zome: "projects", fn: "fetch_outcomes", input: { All: null } },
  connections: {
    zome: "projects",
    fn: "fetch_connections",
    input: { All: null },
  },
  entryPoints: {
    zome: "projects",
    fn: "fetch_entry_points",
    input: { All: null },
  },
  comments: {
    zome: "projects",
    fn: "fetch_outcome_comments",
    input: { All: null },
  },
  outcomeMembers: {
    zome: "projects",
    fn: "fetch_outcome_members",
    input: { All: null },
  },
  tags: { zome: "projects", fn: "fetch_tags", input: { All: null } },
  projectMetas: {
    zome: "projects",
    fn: "fetch_project_metas",
    input: { All: null },
  },
  members: { zome: "projects", fn: "fetch_members", input: null },
  profiles: { zome: "profiles", fn: "fetch_agents", input: null },
};

export const KIND_FOR: Record<string, FetchKind> = {
  AcornOutcome: "outcomes",
  AcornConnection: "connections",
  AcornEntryPoint: "entryPoints",
  AcornOutcomeComment: "comments",
  AcornOutcomeMember: "outcomeMembers",
  AcornTag: "tags",
  AcornProjectMeta: "projectMetas",
  AcornMember: "members",
  AcornProfile: "profiles",
};

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

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** One record a signal asks the Reconciler to re-check. */
export interface HintTarget {
  class: string;
  kind: FetchKind;
  /** the record's mounted address (CRUD records) … */
  address?: string;
  /** … or the agent key it is found by (members, profiles) */
  agent?: string;
  /** the hint claims a create (presence suffices) vs an update */
  create: boolean;
  /** the claim's `updatedAt` (µs) for an update — hdk_crud's sys_time()
   *  taken AFTER the update committed, so ≥ the stored action stamp */
  claimedAt?: number;
}

/** The records a decoded signal claims changed. Deletes and
 *  DeleteOutcomeFully yield none (see the header: never proof). */
export function hintTargets(decoded: any): HintTarget[] {
  if (!decoded || typeof decoded !== "object") return [];
  const signalType: unknown = decoded.signalType;
  const payload = decoded.data;
  if (typeof signalType !== "string" || payload == null || typeof payload !== "object") {
    return [];
  }
  const action: unknown = payload.action;
  const inner = payload.data;
  if (action !== "create" && action !== "update") return [];
  const create = action === "create";

  if (signalType === "OutcomeWithConnection") {
    const out: HintTarget[] = [];
    const o = str(inner?.outcome?.actionHash);
    if (o) out.push({ class: "AcornOutcome", kind: "outcomes", address: o, create: true });
    const c = str(inner?.maybeConnection?.actionHash);
    if (c) out.push({ class: "AcornConnection", kind: "connections", address: c, create: true });
    return out;
  }
  if (signalType === "Member") {
    // MemberSignal carries a bare Member (no hash): found by agent key
    if (entryTypeOf(payload) !== "member") return [];
    const agent = str(inner?.agentPubKey);
    return agent ? [{ class: "AcornMember", kind: "members", agent, create }] : [];
  }
  if (signalType === "Agent") {
    // profiles zome's own SignalType; mounted at profile/<AgentPubKeyB64>
    const agent = str((inner?.entry ?? inner)?.agentPubKey);
    return agent ? [{ class: "AcornProfile", kind: "profiles", agent, create }] : [];
  }
  const className = CLASS_FOR[signalType];
  if (!className) return []; // RealtimeInfo, EditingOutcome, OutcomeVote
  const address = str(inner?.actionHash);
  if (!address) return [];
  const claimedAt = typeof inner?.updatedAt === "number" ? inner.updatedAt : undefined;
  return [
    {
      class: className,
      kind: KIND_FOR[className],
      address,
      create,
      ...(create || claimedAt === undefined ? {} : { claimedAt }),
    },
  ];
}
