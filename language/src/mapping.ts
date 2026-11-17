// Acorn entries -> mount data (design §4). Pure functions; the snapshot and
// the delta paths share them. References become full `<lang>://<hash>` URLs,
// agents become did:key strings, and Option fields that are null stay absent
// (the expansion writes no link for a missing or null value either way, and
// fields of the other `scope` variant must not appear at all).

import { agentToDid } from "./agent";

/** Derived outcome tree edges from the connections of the same snapshot. */
export interface Derived {
  /** child outcome actionHash -> parent outcome actionHash */
  parents: Map<string, string>;
  /** parent outcome actionHash -> child outcome actionHashes, fetch order */
  children: Map<string, string[]>;
}

export interface MapCtx {
  /** this language's address; refs are `<lang>://<hash>` */
  lang: string;
  hashToUrl: (hash: string) => string;
  agentToDid: (b64: string) => string;
  derived?: Derived;
}

/** connection records -> the parent/children maps `toData` consults. */
export function deriveRelations(connections: any[]): Derived {
  const parents = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const rec of connections) {
    const e = rec?.entry ?? rec;
    const parent = e?.parentActionHash;
    const child = e?.childActionHash;
    if (typeof parent !== "string" || typeof child !== "string") continue;
    parents.set(child, parent);
    const list = children.get(parent) ?? [];
    list.push(child);
    children.set(parent, list);
  }
  return { parents, children };
}

/** The mount address of a record: its create action hash, or
 *  `profile/<AgentPubKeyB64>` for profiles (fetch_agents returns bare
 *  Profiles — Correction 6). */
export function addressOf(className: string, record: any): string {
  const entry = record?.entry ?? record;
  if (className === "AcornProfile") {
    return `profile/${entry.agentPubKey}`;
  }
  return record.actionHash;
}

function isWireRecord(record: any): boolean {
  return (
    record != null &&
    typeof record === "object" &&
    "entry" in record &&
    "actionHash" in record
  );
}

// A null/undefined source field writes no key at all; "", 0, false and [] are
// real values and stay.
function put(data: Record<string, unknown>, name: string, value: unknown) {
  if (value !== null && value !== undefined) data[name] = value;
}

/** Map one record to its mount `data` object. `record` is a hdk_crud
 *  WireRecord `{actionHash, entryHash, entry, createdAt, updatedAt}` for every
 *  class except AcornProfile, which gets the bare Profile `fetch_agents`
 *  returns. */
export function toData(
  className: string,
  record: any,
  ctx: MapCtx
): Record<string, unknown> {
  const entry = isWireRecord(record) ? record.entry : record;
  const data: Record<string, unknown> = {};

  switch (className) {
    case "AcornOutcome": {
      put(data, "content", entry.content);
      put(data, "description", entry.description);
      put(data, "githubLink", entry.githubLink);
      const scope = entry.scope ?? {};
      if (scope.Small != null) {
        put(data, "scopeType", "Small");
        put(data, "achievementStatus", scope.Small.achievementStatus);
        put(data, "targetDate", scope.Small.targetDate);
        put(data, "taskList", JSON.stringify(scope.Small.taskList ?? []));
      } else if (scope.Uncertain != null) {
        put(data, "scopeType", "Uncertain");
        put(data, "smallsEstimate", scope.Uncertain.smallsEstimate);
        if (scope.Uncertain.timeFrame != null) {
          put(data, "timeFrame", JSON.stringify(scope.Uncertain.timeFrame));
        }
        put(data, "inBreakdown", scope.Uncertain.inBreakdown);
      }
      if (Array.isArray(entry.tags)) {
        data.tags = entry.tags.map((h: string) => ctx.hashToUrl(h));
      }
      put(data, "creator", entry.creatorAgentPubKey && ctx.agentToDid(entry.creatorAgentPubKey));
      put(data, "editor", entry.editorAgentPubKey && ctx.agentToDid(entry.editorAgentPubKey));
      put(data, "timestampCreated", entry.timestampCreated);
      put(data, "timestampUpdated", entry.timestampUpdated);
      put(data, "isImported", entry.isImported);
      const parent = ctx.derived?.parents.get(record.actionHash);
      if (parent) put(data, "parent", ctx.hashToUrl(parent));
      const children = ctx.derived?.children.get(record.actionHash);
      if (children?.length) {
        data.children = children.map((h) => ctx.hashToUrl(h));
      }
      break;
    }
    case "AcornConnection": {
      put(data, "parent", entry.parentActionHash && ctx.hashToUrl(entry.parentActionHash));
      put(data, "child", entry.childActionHash && ctx.hashToUrl(entry.childActionHash));
      put(data, "siblingOrder", entry.siblingOrder);
      put(data, "randomizer", entry.randomizer);
      put(data, "isImported", entry.isImported);
      break;
    }
    case "AcornEntryPoint": {
      put(data, "color", entry.color);
      put(data, "outcome", entry.outcomeActionHash && ctx.hashToUrl(entry.outcomeActionHash));
      put(data, "creator", entry.creatorAgentPubKey && ctx.agentToDid(entry.creatorAgentPubKey));
      put(data, "createdAtTime", entry.createdAt);
      put(data, "isImported", entry.isImported);
      break;
    }
    case "AcornOutcomeComment": {
      put(data, "outcome", entry.outcomeActionHash && ctx.hashToUrl(entry.outcomeActionHash));
      put(data, "content", entry.content);
      put(data, "creator", entry.creatorAgentPubKey && ctx.agentToDid(entry.creatorAgentPubKey));
      put(data, "unixTimestamp", entry.unixTimestamp);
      put(data, "isImported", entry.isImported);
      break;
    }
    case "AcornOutcomeMember": {
      put(data, "outcome", entry.outcomeActionHash && ctx.hashToUrl(entry.outcomeActionHash));
      put(data, "member", entry.memberAgentPubKey && ctx.agentToDid(entry.memberAgentPubKey));
      put(data, "creator", entry.creatorAgentPubKey && ctx.agentToDid(entry.creatorAgentPubKey));
      put(data, "unixTimestamp", entry.unixTimestamp);
      put(data, "isImported", entry.isImported);
      break;
    }
    case "AcornTag": {
      put(data, "text", entry.text);
      put(data, "backgroundColor", entry.backgroundColor);
      break;
    }
    case "AcornProjectMeta": {
      put(data, "name", entry.name);
      put(data, "image", entry.image);
      put(data, "layeringAlgorithm", entry.layeringAlgorithm);
      if (Array.isArray(entry.topPriorityOutcomes)) {
        data.topPriorityOutcomes = entry.topPriorityOutcomes.map((h: string) =>
          ctx.hashToUrl(h)
        );
      }
      put(data, "creator", entry.creatorAgentPubKey && ctx.agentToDid(entry.creatorAgentPubKey));
      put(data, "createdAtTime", entry.createdAt);
      put(data, "isImported", entry.isImported);
      put(data, "isMigrated", entry.isMigrated);
      // `passphrase` is the project's membership secret: never mapped.
      break;
    }
    case "AcornMember": {
      put(data, "agent", entry.agentPubKey && ctx.agentToDid(entry.agentPubKey));
      break;
    }
    case "AcornProfile": {
      put(data, "firstName", entry.firstName);
      put(data, "lastName", entry.lastName);
      put(data, "handle", entry.handle);
      put(data, "status", entry.status);
      put(data, "avatarUrl", entry.avatarUrl);
      put(data, "agent", entry.agentPubKey && ctx.agentToDid(entry.agentPubKey));
      put(data, "agentPubKey", entry.agentPubKey);
      put(data, "isImported", entry.isImported);
      break;
    }
    default:
      throw new Error(`toData: unknown class ${className}`);
  }

  // WireRecord metadata, read-only (createdAt/updatedAt are reserved names —
  // Correction 13). AcornProfile arrives bare and gets none of these.
  if (isWireRecord(record)) {
    put(data, "entryHash", record.entryHash);
    put(data, "recordCreatedAt", record.createdAt);
    put(data, "recordUpdatedAt", record.updatedAt);
  }

  return data;
}
