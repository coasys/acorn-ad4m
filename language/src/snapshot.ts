// mountSnapshot(): every Acorn record of the project as mount entries
// (design §4.3). Nine reads in one Promise.all — the language's call queue
// is shared with writes, so the snapshot must stay fast (R6). The last
// snapshot is kept in a module-level map for expressionGet.

import { holochainCall } from "ad4m:host";
import { agentToDid } from "./agent";
import { addressOf, deriveRelations, toData, type MapCtx } from "./mapping";

const NICK = "projects";

export interface SnapshotEntry {
  class: string;
  address: string;
  data: Record<string, unknown>;
}

/** address -> {class, data} of the last snapshot `mountSnapshot` returned. */
export const lastSnapshot = new Map<
  string,
  { class: string; data: Record<string, unknown> }
>();

const FETCH_ALL = { input: { All: null }, local: true };
const FETCH_NONE = { input: null, local: true };

function isNoProjectMeta(e: unknown): boolean {
  return String((e as Error)?.message ?? e)
    .toLowerCase()
    .includes("no project meta");
}

/** Identity the snapshot needs beyond `lang`: the own agent key (whose
 *  member gets `sameAs`) and the AD4M DID it points to (Correction 15). */
export interface SnapshotIdentity {
  ownAgent?: string;
  ad4mDid?: string;
}

export async function takeSnapshot(
  lang: string,
  own: SnapshotIdentity = {}
): Promise<{ entries: SnapshotEntry[] }> {
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
  lastSnapshot.clear();
  const push = (className: string, record: any) => {
    const data = toData(className, record, ctx);
    const address = addressOf(className, record);
    entries.push({ class: className, address, data });
    lastSnapshot.set(address, { class: className, data });
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

  return { entries };
}
