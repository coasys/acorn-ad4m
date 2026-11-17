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
// does not fetch produces nothing; a profile is emitted only as fetched,
// for the agent key the claim names.
//
// Deletion (Lal round 2, P1): a hint NEVER removes a mounted record. A
// removal would need proof of a tombstone, and the stock zomes expose no
// read that gives one: every fetch_* goes through hdk_crud's
// get_latest_for_entry, which answers None alike for
// EntryDhtStatus::Dead, for details not (yet) gossiped to us and — in
// fetch_links/Specific — for a per-record error it silently drops. So
// "absent from the list" is inconclusive, and the only path that removes
// is the periodic full resync (mountSnapshot). Every target is also bound
// to the class it is mounted as: a hint about class X never changes a
// record mounted as class Y.
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

  // Class binding: may a record of `className` be (re)mounted at `addr`?
  // Only when nothing else is mounted there.
  const boundTo = (addr: string, className: string): boolean => {
    const hit = ctx.snapshot.get(addr);
    return !hit || hit.class === className;
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
    if (!addr || have.has(addr) || !boundTo(addr, "AcornOutcome")) return;
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
    let addr = str(claim?.actionHash);
    const connClaim = inner?.maybeConnection;
    let connHash = str(connClaim?.actionHash);
    if (addr && !boundTo(addr, "AcornOutcome")) addr = null;
    if (connHash && !boundTo(connHash, "AcornConnection")) connHash = null;
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
    // a deletion claim — never proof (P1); the resync removes.
    return null;
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
    if (rec?.actionHash && boundTo(rec.actionHash, "AcornMember")) {
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
    // an unconfirmed claim — create, update or delete — changes nothing
    return null;
  }

  if (signalType === "Agent") {
    // profiles zome's own SignalType; mounted at profile/<AgentPubKeyB64>.
    // The emitted profile is only ever the fetched one for the claimed key.
    if (action === "create" || action === "update") {
      const claim = inner?.entry ?? inner;
      const key = str(claim?.agentPubKey);
      if (!key || !boundTo(`profile/${key}`, "AcornProfile")) return null;
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

  // a deletion claim — never proof (P1); the resync removes.
  if (action === "delete") return null;

  if (action === "create" || action === "update") {
    const addr = str(inner?.actionHash);
    if (!addr || !boundTo(addr, className)) return null;
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
