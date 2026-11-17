// mountSnapshot(): every Acorn record of the project as mount entries
// (design §4.3). Nine reads in one Promise.all — the language's call queue
// is shared with writes, so the snapshot must stay fast (R6). The result
// is merged into the module-level mount state (state.ts) through its
// revision guard; the merged mount is what mountSnapshot answers.

import { holochainCall } from "ad4m:host";
import { agentToDid } from "./agent";
import {
  addressOf,
  deriveFromMounted,
  reexpandOutcome,
  toData,
  type MapCtx,
} from "./mapping";
import {
  mountState,
  type MountDelta,
  type SnapshotEntry,
  type SnapshotIdentity,
} from "./state";

const NICK = "projects";

const FETCH_ALL = { input: { All: null }, local: true };
const FETCH_NONE = { input: null, local: true };

function isNoProjectMeta(e: unknown): boolean {
  return String((e as Error)?.message ?? e)
    .toLowerCase()
    .includes("no project meta");
}

// A full read reconciled into the mount state (state.ts MountState): the
// sequence number is taken before the reads start, so a signal-driven
// fetch that lands meanwhile is ordered correctly against it. Applied in
// two phases (Lal round 3, F2): every class but outcomes first, then the
// outcomes with parent/children derived from the MOUNTED connections —
// only guard-accepted connections feed edges, and a connection this read
// failed to list keeps its edge until it is itself removed (F1). If the
// removal pass drops a connection, the mounted outcomes are re-derived.
// `complete: false` marks a read whose absences must not count toward
// removal (the worker's overflow fallback — Lal round 3, F1); a `fence`
// that turned stale while reading (the worker's deadline passed — F3)
// makes the read apply nothing. Answers the
// whole mount after the merge plus the delta the merge made.
export async function resyncSnapshot(
  lang: string,
  own: SnapshotIdentity = {},
  opts: { complete?: boolean; fence?: { stale(): boolean } } = {}
): Promise<{ entries: SnapshotEntry[]; delta: MountDelta; seq: number }> {
  const seq = mountState.beginRead();
  const startedAt = Date.now();
  const { others, outcomes, ctx } = await readSnapshot(lang, own);
  if (opts.fence?.stale()) {
    // the worker gave up on this (overflow) read: it applies nothing
    return { entries: mountState.list(), delta: { changed: [], removed: [] }, seq };
  }
  const changed = new Map<string, SnapshotEntry>();
  const note = (es: SnapshotEntry[]) => es.forEach((e) => changed.set(e.address, e));

  note(mountState.applyChanged(others, seq));
  const derived = deriveFromMounted(mountState.entries, lang);
  const outs = outcomes.map((r) => ({
    class: "AcornOutcome",
    address: addressOf("AcornOutcome", r),
    data: toData("AcornOutcome", r, { ...ctx, derived }),
  }));
  note(mountState.applyChanged(outs, seq));

  const seen = new Set([...others, ...outs].map((e) => e.address));
  const conns = new Set(
    [...mountState.entries].filter(([, e]) => e.class === "AcornConnection").map(([a]) => a)
  );
  const removed = mountState.finishFullRead(seen, seq, {
    complete: opts.complete !== false,
    startedAt,
  });
  if (removed.some((a) => conns.has(a))) {
    // edges of removed connections: re-derive every mounted outcome
    const d2 = deriveFromMounted(mountState.entries, lang);
    const again: SnapshotEntry[] = [];
    for (const [address, e] of mountState.entries) {
      if (e.class !== "AcornOutcome") continue;
      again.push(reexpandOutcome(address, e.data, d2, lang));
    }
    note(mountState.applyChanged(again, seq));
  }
  for (const a of removed) changed.delete(a);
  return { entries: mountState.list(), delta: { changed: [...changed.values()], removed }, seq };
}

export async function takeSnapshot(
  lang: string,
  own: SnapshotIdentity = {}
): Promise<{ entries: SnapshotEntry[] }> {
  const { entries } = await resyncSnapshot(lang, own);
  return { entries };
}

// Every Acorn record of the project — reads only. Outcomes come back raw:
// their derived edges are computed against the mount (resyncSnapshot).
async function readSnapshot(
  lang: string,
  own: SnapshotIdentity
): Promise<{ others: SnapshotEntry[]; outcomes: any[]; ctx: MapCtx }> {
  const [
    outcomes,
    connections,
    entryPoints,
    comments,
    outcomeMembers,
    tags,
    projectMeta,
    members,
    profiles,
  ] = await Promise.all([
    holochainCall(NICK, "projects", "fetch_outcomes", FETCH_ALL),
    holochainCall(NICK, "projects", "fetch_connections", FETCH_ALL),
    holochainCall(NICK, "projects", "fetch_entry_points", FETCH_ALL),
    holochainCall(NICK, "projects", "fetch_outcome_comments", FETCH_ALL),
    holochainCall(NICK, "projects", "fetch_outcome_members", FETCH_ALL),
    holochainCall(NICK, "projects", "fetch_tags", FETCH_ALL),
    // fetch_project_meta throws "no project meta exists" until one is
    // written; that is "no entry", not a snapshot failure.
    holochainCall(NICK, "projects", "fetch_project_meta", FETCH_NONE).catch(
      (e) => {
        if (isNoProjectMeta(e)) return null;
        throw e;
      }
    ),
    holochainCall(NICK, "projects", "fetch_members", FETCH_NONE),
    // fetch_agents returns bare Profiles (no WireRecord) — Correction 6.
    holochainCall(NICK, "profiles", "fetch_agents", FETCH_NONE),
  ]);

  const ctx: MapCtx = {
    lang,
    hashToUrl: (h) => `${lang}://${h}`,
    agentToDid,
    ownAgent: own.ownAgent,
    ad4mDid: own.ad4mDid,
  };

  const others: SnapshotEntry[] = [];
  const push = (className: string, record: any) => {
    const data = toData(className, record, ctx);
    const address = addressOf(className, record);
    others.push({ class: className, address, data });
  };

  for (const r of connections ?? []) push("AcornConnection", r);
  for (const r of entryPoints ?? []) push("AcornEntryPoint", r);
  for (const r of comments ?? []) push("AcornOutcomeComment", r);
  for (const r of outcomeMembers ?? []) push("AcornOutcomeMember", r);
  for (const r of tags ?? []) push("AcornTag", r);
  if (projectMeta) push("AcornProjectMeta", projectMeta);
  for (const r of members ?? []) push("AcornMember", r);
  for (const p of profiles ?? []) push("AcornProfile", p);

  return { others, outcomes: outcomes ?? [], ctx };
}
