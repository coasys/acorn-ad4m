// mountSnapshot(): every Acorn record of the project as mount entries
// (design §4.3). Nine reads in one Promise.all — the language's call queue
// is shared with writes, so the snapshot must stay fast (R6). The result
// is merged into the module-level mount state (state.ts) through its
// revision guard; the merged mount is what mountSnapshot answers.

import { holochainCall } from "ad4m:host";
import { agentToDid } from "./agent";
import { addressOf, deriveRelations, toData, type MapCtx } from "./mapping";
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
// fetch that lands meanwhile is ordered correctly against it. Answers the
// whole mount after the merge plus the delta the merge made.
export async function resyncSnapshot(
  lang: string,
  own: SnapshotIdentity = {}
): Promise<{ entries: SnapshotEntry[]; delta: MountDelta }> {
  const seq = mountState.beginRead();
  const read = await readSnapshot(lang, own);
  const delta = mountState.applySnapshot(read, seq);
  return { entries: mountState.list(), delta };
}

export async function takeSnapshot(
  lang: string,
  own: SnapshotIdentity = {}
): Promise<{ entries: SnapshotEntry[] }> {
  const { entries } = await resyncSnapshot(lang, own);
  return { entries };
}

// Every Acorn record of the project as mount entries — reads only.
async function readSnapshot(
  lang: string,
  own: SnapshotIdentity
): Promise<SnapshotEntry[]> {
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
    derived: deriveRelations(connections),
  };

  const entries: SnapshotEntry[] = [];
  const push = (className: string, record: any) => {
    const data = toData(className, record, ctx);
    const address = addressOf(className, record);
    entries.push({ class: className, address, data });
  };

  for (const r of outcomes ?? []) push("AcornOutcome", r);
  for (const r of connections ?? []) push("AcornConnection", r);
  for (const r of entryPoints ?? []) push("AcornEntryPoint", r);
  for (const r of comments ?? []) push("AcornOutcomeComment", r);
  for (const r of outcomeMembers ?? []) push("AcornOutcomeMember", r);
  for (const r of tags ?? []) push("AcornTag", r);
  if (projectMeta) push("AcornProjectMeta", projectMeta);
  for (const r of members ?? []) push("AcornMember", r);
  for (const p of profiles ?? []) push("AcornProfile", p);

  return entries;
}
