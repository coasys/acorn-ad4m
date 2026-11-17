// Acorn entries -> mount data (design §4). Pure functions; the snapshot and
// the delta paths share them. References become full `<lang>://<hash>` URLs,
// agents become did:key strings, and Option fields that are null stay absent
// (the expansion writes no link for a missing or null value either way, and
// fields of the other `scope` variant must not appear at all).

import { agentToDid } from "./agent";
import { writablePropNames } from "./shapes";

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

// --- mount data -> Acorn entries (B3 write side) ---------------------------
//
// toEntry is the exact inverse of toData: `<lang>://<hash>` URLs become
// ActionHashB64 again, did:key agents become AgentPubKeyB64, scopeType + the
// flattened scope fields rebuild the externally tagged `scope` enum, and the
// JSON-string `taskList`/`timeFrame` parse back to values. Everything that is
// not an entry field — WireRecord metadata, derived parent/children — is
// dropped.

export interface ToEntryCtx {
  /** this language's address; refs arrive as `<lang>://<hash>` */
  lang: string;
  didToAgent: (did: string) => string;
  /** project network seed: the ONLY source of ProjectMeta.passphrase */
  seed?: string;
}

/** "uid-a-b-c-d-e" -> "a b c d e" — the inverse of Acorn's uidToPassphrase
 *  (web/src/secrets.ts:8-9), so the stock UI's passphrase convention holds. */
export function seedToPassphrase(seed: string): string {
  return (seed.startsWith("uid-") ? seed.slice(4) : seed).split("-").join(" ");
}

/** `<lang>://<hash>` -> `<hash>`; a bare hash passes through unchanged. */
export function urlToHash(url: unknown, lang: string): string {
  const s = String(url);
  const prefix = `${lang}://`;
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

// did:key -> AgentPubKeyB64; a raw key passes through unchanged.
function agentValue(v: unknown, ctx: ToEntryCtx): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.startsWith("did:") ? ctx.didToAgent(s) : s;
}

// A mounted JSON-string field ("[...]", "{...}") parses back to its value;
// anything already a value passes through.
function jsonValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function scopeToEntry(data: Record<string, unknown>): Record<string, unknown> {
  if (data.scopeType === "Small") {
    return {
      Small: {
        achievementStatus: data.achievementStatus ?? "NotAchieved",
        targetDate: data.targetDate ?? null,
        taskList: jsonValue(data.taskList) ?? [],
      },
    };
  }
  return {
    Uncertain: {
      smallsEstimate: data.smallsEstimate ?? null,
      timeFrame: jsonValue(data.timeFrame),
      inBreakdown: data.inBreakdown ?? false,
    },
  };
}

export function toEntry(
  className: string,
  data: Record<string, unknown>,
  ctx: ToEntryCtx
): Record<string, unknown> {
  const ref = (v: unknown) => (v == null ? null : urlToHash(v, ctx.lang));
  const agent = (v: unknown) => agentValue(v, ctx);
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const refs = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => ref(x)).filter((x): x is string => x != null)
      : [];

  switch (className) {
    case "AcornOutcome":
      return {
        content: str(data.content),
        creatorAgentPubKey: agent(data.creator),
        editorAgentPubKey: agent(data.editor),
        timestampCreated: num(data.timestampCreated),
        timestampUpdated: data.timestampUpdated ?? null,
        scope: scopeToEntry(data),
        tags: refs(data.tags),
        description: str(data.description),
        isImported: data.isImported === true,
        githubLink: str(data.githubLink),
      };
    case "AcornConnection":
      return {
        parentActionHash: ref(data.parent),
        childActionHash: ref(data.child),
        siblingOrder: num(data.siblingOrder),
        randomizer: num(data.randomizer),
        isImported: data.isImported === true,
      };
    case "AcornEntryPoint":
      return {
        color: str(data.color),
        creatorAgentPubKey: agent(data.creator),
        createdAt: num(data.createdAtTime),
        outcomeActionHash: ref(data.outcome),
        isImported: data.isImported === true,
      };
    case "AcornOutcomeComment":
      return {
        outcomeActionHash: ref(data.outcome),
        content: str(data.content),
        creatorAgentPubKey: agent(data.creator),
        unixTimestamp: num(data.unixTimestamp),
        isImported: data.isImported === true,
      };
    case "AcornOutcomeMember":
      return {
        outcomeActionHash: ref(data.outcome),
        memberAgentPubKey: agent(data.member),
        creatorAgentPubKey: agent(data.creator),
        unixTimestamp: num(data.unixTimestamp),
        isImported: data.isImported === true,
      };
    case "AcornTag":
      return {
        backgroundColor: str(data.backgroundColor),
        text: str(data.text),
      };
    case "AcornProjectMeta":
      return {
        creatorAgentPubKey: agent(data.creator),
        createdAt: num(data.createdAtTime),
        name: str(data.name),
        image: data.image ?? null,
        // The project passphrase is derived from the language seed — it is
        // never mounted data and never accepted from interaction params.
        passphrase:
          typeof data.passphrase === "string" && data.passphrase !== ""
            ? data.passphrase
            : seedToPassphrase(ctx.seed ?? ""),
        isImported: data.isImported === true,
        layeringAlgorithm: str(data.layeringAlgorithm),
        topPriorityOutcomes: refs(data.topPriorityOutcomes),
        isMigrated: data.isMigrated ?? null,
      };
    case "AcornMember":
      return { agentPubKey: agent(data.agent) };
    case "AcornProfile":
      return {
        firstName: str(data.firstName),
        lastName: str(data.lastName),
        handle: str(data.handle),
        status: str(data.status),
        avatarUrl: str(data.avatarUrl),
        agentPubKey:
          typeof data.agentPubKey === "string" && data.agentPubKey !== ""
            ? data.agentPubKey
            : agent(data.agent),
        isImported: data.isImported === true,
      };
    default:
      throw new Error(`toEntry: unknown class ${className}`);
  }
}

/** The merge half of update's read-modify-write (design §3.3): the current
 *  entry maps to mount data, `params` — only the shape's writable properties —
 *  overlay it, and the result maps back to a complete new entry. Read-only
 *  props in `params` are dropped, so only the changed keys can differ. */
export function mergeForUpdate(
  className: string,
  currentEntry: any,
  params: Record<string, unknown>,
  ctx: MapCtx & ToEntryCtx
): Record<string, unknown> {
  const data = toData(className, currentEntry, ctx);
  const merged = { ...data };
  for (const name of writablePropNames(className)) {
    if (params[name] !== undefined) merged[name] = params[name];
  }
  return toEntry(className, merged, ctx);
}
