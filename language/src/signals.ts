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
// Verification (B6, Lal review P1): a signal is ONLY an invalidation hint.
// The payload names the records that claim to have changed; the delta is
// built exclusively from records fetched through the zomes (`ctx.fetch`,
// the same read path the snapshot uses) — the DHT's signed, validated
// copies. Signal fields never reach a delta: a claimed create/update that
// does not fetch produces nothing; a claimed delete produces `removed`
// only when the fetch confirms the record is gone; a profile is emitted
// only as fetched, for the agent key the claim names.
//
// `signalToDelta` is async and poll-bounded: a signal routinely lands
// before the op it announces has gossiped in, so each confirmation polls
// `ctx.confirmTries` × `ctx.confirmDelayMs` (default 20 × 650 ms ≈ 13 s —
// under the ~15 s resync it is meant to beat and the 60 s language call
// budget) before deferring to the resync. Fetch errors propagate — an
// unreadable collection must never look like "confirmed gone".

import { decode } from "@msgpack/msgpack";
import { agentToDid } from "./agent";
import {
  deriveRelations,
  toData,
  urlToHash,
  type Derived,
  type MapCtx,
} from "./mapping";
import type { SnapshotEntry } from "./state";

export interface MountDelta {
  address?: string;
  changed: SnapshotEntry[];
  removed: string[];
}

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

const KIND_FOR: Record<string, FetchKind> = {
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

export interface SignalCtx {
  lang: string;
  /** read view of `lastSnapshot`: address -> {class, data} */
  snapshot: ReadonlyMap<string, { class: string; data: Record<string, unknown> }>;
  /** the verified read path (B2's fetch_* calls). Required — a signal that
   *  cannot be verified produces null. */
  fetch: (kind: FetchKind) => Promise<any[]>;
  /** the language cell's own AgentPubKeyB64 + the executor's AD4M DID —
   *  the own member's sameAs, as in takeSnapshot (Correction 15) */
  ownAgent?: string;
  ad4mDid?: string;
  /** poll budget for confirming a claim before deferring to the resync
   *  (default 20 × 650 ms ≈ 13 s — under the ~15 s resync) */
  confirmTries?: number;
  confirmDelayMs?: number;
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

function mapCtx(ctx: SignalCtx, derived?: Derived): MapCtx {
  return {
    lang: ctx.lang,
    hashToUrl: (h) => `${ctx.lang}://${h}`,
    agentToDid,
    ownAgent: ctx.ownAgent,
    ad4mDid: ctx.ad4mDid,
    derived,
  };
}

interface ConnEdge {
  parent: string;
  child: string;
}

/** connAddress -> {parent, child} (hashes) of every connection the last
 *  snapshot holds, in snapshot order. The mounted values were verified by
 *  an earlier fetch, so they are a safe source for the OLD endpoints of a
 *  confirmed connection change. */
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

// Re-expand one outcome's mounted data with recomputed derived edges —
// same semantics as toData's parent/children, applied to snapshot data
// (the fallback when the outcome itself did not fetch).
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

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export async function signalToDelta(
  decoded: any,
  ctx: SignalCtx
): Promise<MountDelta | null> {
  if (!decoded || typeof decoded !== "object") return null;
  const signalType: unknown = decoded.signalType;
  const payload = decoded.data;
  if (
    typeof signalType !== "string" ||
    payload == null ||
    typeof payload !== "object" ||
    typeof ctx.fetch !== "function"
  ) {
    return null;
  }
  const action: unknown = payload.action;
  const inner = payload.data;

  const tries = Math.max(1, ctx.confirmTries ?? 20);
  const delayMs = Math.max(0, ctx.confirmDelayMs ?? 650);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Fetch cache: `rows` gives the freshest list already pulled (each
  // `freshRows` poll refreshes it); derived edges and expansions build on
  // the same verified view.
  const cache = new Map<FetchKind, any[]>();
  const rows = async (kind: FetchKind): Promise<any[]> => {
    if (!cache.has(kind)) cache.set(kind, (await ctx.fetch(kind)) ?? []);
    return cache.get(kind)!;
  };
  const freshRows = async (kind: FetchKind): Promise<any[]> => {
    const r = (await ctx.fetch(kind)) ?? [];
    cache.set(kind, r);
    return r;
  };
  const poll = async <T>(probe: () => Promise<T | null>): Promise<T | null> => {
    for (let i = 0; i < tries; i++) {
      const r = await probe();
      if (r != null) return r;
      if (i + 1 < tries) await sleep(delayMs);
    }
    return null;
  };

  // The fetched record behind a claimed actionHash, or null when the claim
  // never verifies. A create confirms on presence; an update confirms once
  // the fetched record's `updatedAt` differs from the mount's last-seen
  // `recordUpdatedAt` — provable new state. The claim's own `updatedAt`
  // cannot be the check: hdk_crud stamps signals with sys_time(), which
  // only approximates the action's stored timestamp, so it never matches.
  const confirmRecord = async (
    kind: FetchKind,
    hash: string,
    forUpdate?: boolean
  ): Promise<any | null> => {
    const prevStamp = ctx.snapshot.get(hash)?.data?.recordUpdatedAt;
    return poll(async () => {
      const rec =
        (await freshRows(kind)).find((r: any) => r?.actionHash === hash) ?? null;
      if (!rec) return null;
      if (forUpdate && prevStamp !== undefined && rec.updatedAt === prevStamp) {
        return null; // still the pre-signal state — keep waiting
      }
      return rec;
    });
  };

  // True only when the record is confirmed ABSENT after the full poll
  // budget — `removed` never leaves on anything less.
  const confirmGone = async (kind: FetchKind, hash: string): Promise<boolean> => {
    const gone = await poll(async () =>
      (await freshRows(kind)).some((r: any) => r?.actionHash === hash)
        ? null
        : true
    );
    return gone === true;
  };

  const changed: SnapshotEntry[] = [];
  const have = new Set<string>();
  const push = (e: SnapshotEntry) => {
    if (have.has(e.address)) return;
    have.add(e.address);
    changed.push(e);
  };

  // Re-expand one outcome with fresh derived edges: the fetched record when
  // present, else the last snapshot's (already verified) data.
  const expandOutcome = async (
    addr: string | null | undefined,
    derived: Derived
  ) => {
    if (!addr || have.has(addr)) return;
    const rec = (await rows("outcomes")).find((r: any) => r?.actionHash === addr);
    if (rec) {
      push({
        class: "AcornOutcome",
        address: addr,
        data: toData("AcornOutcome", rec, mapCtx(ctx, derived)),
      });
      return;
    }
    const hit = ctx.snapshot.get(addr);
    if (hit?.class === "AcornOutcome") {
      push(reexpandOutcome(addr, hit.data, derived, ctx));
    }
  };
  const expandTouched = async (
    addrs: Iterable<string | null | undefined>,
    derived: Derived
  ) => {
    for (const a of addrs) await expandOutcome(a, derived);
  };

  // ---- custom structs -----------------------------------------------

  if (signalType === "OutcomeWithConnection") {
    const claim = inner?.outcome;
    const addr = str(claim?.actionHash);
    const connClaim = inner?.maybeConnection;
    const connHash = str(connClaim?.actionHash);
    const outcomeRec = addr
      ? await confirmRecord("outcomes", addr)
      : null;
    const connRec = connHash
      ? await poll(
          async () =>
            (await freshRows("connections")).find(
              (r: any) => r?.actionHash === connHash
            ) ?? null
        )
      : null;
    if (!outcomeRec && !connRec) return null;
    const derived = deriveRelations(await rows("connections"));
    if (outcomeRec && addr) {
      push({
        class: "AcornOutcome",
        address: addr,
        data: toData("AcornOutcome", outcomeRec, mapCtx(ctx, derived)),
      });
    }
    if (connRec) {
      push({
        class: "AcornConnection",
        address: connRec.actionHash,
        data: toData("AcornConnection", connRec, mapCtx(ctx, derived)),
      });
      await expandTouched(
        [connRec.entry?.parentActionHash, connRec.entry?.childActionHash].filter(
          (a) => a !== addr
        ),
        derived
      );
    }
    return { changed, removed: [] };
  }

  if (signalType === "DeleteOutcomeFully") {
    const outcome = str(inner?.outcomeActionHash);
    if (!outcome) return null;
    // the head record must confirm gone before anything is removed
    if (!(await confirmGone("outcomes", outcome))) return null;
    const snap = snapshotConns(ctx);
    const conns = await freshRows("connections");
    const touched = new Set<string>();
    const removed = new Set<string>([outcome]);
    const lists: [unknown, FetchKind][] = [
      [inner.deletedConnections, "connections"],
      [inner.deletedOutcomeMembers, "outcomeMembers"],
      [inner.deletedOutcomeComments, "comments"],
      [inner.deletedEntryPoints, "entryPoints"],
    ];
    for (const [list, kind] of lists) {
      if (!Array.isArray(list)) continue;
      const present = new Set(
        (kind === "connections" ? conns : await freshRows(kind)).map(
          (r: any) => r?.actionHash
        )
      );
      for (const h of list) {
        if (typeof h !== "string" || present.has(h)) continue;
        removed.add(h);
        if (kind === "connections") {
          const c = snap.get(h);
          if (c) {
            touched.add(c.parent);
            touched.add(c.child);
          }
        }
      }
    }
    touched.delete(outcome);
    const derived = deriveRelations(conns);
    await expandTouched(touched, derived);
    return { changed, removed: [...removed] };
  }

  if (signalType === "Member") {
    // MemberSignal carries a bare Member (no hash); the fetched member's
    // actionHash is the mounted address.
    if (entryTypeOf(payload) !== "member") return null;
    const key = str(inner?.agentPubKey);
    if (!key) return null;
    const rec = await poll(
      async () =>
        (await freshRows("members")).find(
          (r: any) => (r?.entry ?? r)?.agentPubKey === key
        ) ?? null
    );
    if (rec?.actionHash) {
      return {
        changed: [
          {
            class: "AcornMember",
            address: rec.actionHash,
            data: toData("AcornMember", rec, mapCtx(ctx)),
          },
        ],
        removed: [],
      };
    }
    // A delete claim removes the mounted record only when its address is
    // known — the snapshot's; an unconfirmed create/update produces nothing.
    if (action === "delete") {
      const did = agentToDid(key);
      for (const [addr, e] of ctx.snapshot) {
        if (e.class === "AcornMember" && e.data.agent === did) {
          return { changed: [], removed: [addr] };
        }
      }
    }
    return null;
  }

  if (signalType === "Agent") {
    // profiles zome's own SignalType; mounted at profile/<AgentPubKeyB64>.
    // The emitted profile is only ever the fetched one for the claimed key.
    if (action === "create" || action === "update") {
      const claim = inner?.entry ?? inner;
      const key = str(claim?.agentPubKey);
      if (!key) return null;
      const rec = await poll(
        async () =>
          (await freshRows("profiles")).find(
            (p: any) => p?.agentPubKey === key
          ) ?? null
      );
      if (!rec) return null;
      return {
        changed: [
          {
            class: "AcornProfile",
            address: `profile/${key}`,
            data: toData("AcornProfile", rec, mapCtx(ctx)),
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
  const kind = KIND_FOR[className];
  if (!kind) return null;

  if (action === "delete") {
    const hash = str(inner) ?? str(inner?.actionHash);
    if (!hash) return null;
    if (!(await confirmGone(kind, hash))) return null;
    if (className === "AcornConnection") {
      // the record is gone; its ends come from the snapshot (verified on
      // an earlier fetch) and are re-expanded against the fresh conn set
      const old = snapshotConns(ctx).get(hash);
      const derived = deriveRelations(await rows("connections"));
      await expandTouched([old?.parent, old?.child], derived);
      return { changed, removed: [hash] };
    }
    return { changed: [], removed: [hash] };
  }

  if (action === "create" || action === "update") {
    const addr = str(inner?.actionHash);
    if (!addr) return null;
    const rec = await confirmRecord(kind, addr, action === "update");
    if (!rec) return null;
    const derived =
      className === "AcornOutcome" || className === "AcornConnection"
        ? deriveRelations(await rows("connections"))
        : undefined;
    push({
      class: className,
      address: addr,
      data: toData(className, rec, mapCtx(ctx, derived)),
    });
    if (className === "AcornConnection") {
      const old = snapshotConns(ctx).get(addr);
      await expandTouched(
        [
          old?.parent,
          old?.child,
          str(rec.entry?.parentActionHash),
          str(rec.entry?.childActionHash),
        ],
        derived!
      );
    }
    return { changed, removed: [] };
  }

  return null;
}
