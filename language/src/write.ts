// B3 write side: the `create` / `update` / `delete` interactions the B2
// shapes point to (design §3.3–3.4). Each one makes the Acorn zome call,
// refreshes the module-level snapshot, and answers the mount delta
// `{ address, changed, removed }` — addresses without the `<lang>://` prefix.
//
// Zome call shapes are documented in zomes.md. Entries carry ActionHashB64 /
// AgentPubKeyB64 strings end to end (no binary crossing).

import { holochainCall } from "ad4m:host";
import { agentToDid, didToAgent } from "./agent";
import {
  toEntry,
  urlToHash,
  type MapCtx,
  type ToEntryCtx,
} from "./mapping";
import { takeSnapshot, type SnapshotEntry } from "./snapshot";
import { isClassName, writablePropNames } from "./shapes";

const NICK = "projects";
const PROFILES_ZOME = "profiles";

/** What an interaction needs besides the caller's params. */
export interface WriteCtx {
  /** this language's address */
  lang: string;
  /** the language cell's own AgentPubKeyB64 */
  ownAgent: string;
  /** the project network seed (template banner) */
  seed: string;
}

interface MountDelta {
  address?: string;
  changed: SnapshotEntry[];
  removed: string[];
}

function mapCtx(ctx: WriteCtx): MapCtx & ToEntryCtx {
  return {
    lang: ctx.lang,
    hashToUrl: (h) => `${ctx.lang}://${h}`,
    agentToDid,
    didToAgent,
    seed: ctx.seed,
  };
}

// The mounted data of the given addresses after a fresh snapshot, in the
// order given; addresses that vanished are skipped.
function pickEntries(
  snap: { entries: SnapshotEntry[] },
  addrs: string[]
): SnapshotEntry[] {
  const byAddr = new Map(snap.entries.map((e) => [e.address, e]));
  return addrs.map((a) => byAddr.get(a)).filter((e): e is SnapshotEntry => e != null);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// unix seconds — the unit moment().unix() writes for the UI's timestamps.
const nowSecs = () => Math.floor(Date.now() / 1000);

// Acorn's UI picks an entry-point color from this palette by char-code sum
// (web/src/styles.ts pickColorForString) — same convention here so a stock
// user sees the same color a UI-created entry point would have.
const COLOR_PALETTE = [
  "#ED4C67", "#F79F1F", "#FDA7DF", "#12CBC4", "#A3CB38", "#1289A7",
  "#D980FA", "#B53471", "#EE5A24", "#009432", "#0652DD", "#9980FA",
  "#833471", "#006266", "#1B1464", "#5758BB", "#6F1E51",
];

function pickColorForString(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return COLOR_PALETTE[sum % COLOR_PALETTE.length];
}

// ---------------------------------------------------------------------------
// parameters -> the data object toEntry consumes
// ---------------------------------------------------------------------------

// Interaction params beyond the shape's writable props: AcornOutcome's
// `parent`+`siblingOrder` drive create_outcome_with_connection's
// maybeLinkedOutcome; every other key must be a writable prop to apply.
const CREATE_EXTRA: Record<string, string[]> = {
  AcornOutcome: ["parent", "siblingOrder"],
};

function createParams(
  className: string,
  params: Record<string, unknown>
): Record<string, unknown> {
  const allowed = new Set([
    ...writablePropNames(className),
    ...(CREATE_EXTRA[className] ?? []),
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

// The Acorn UI's create defaults (web/src/components/…): creator is the
// writing agent, timestamps in the UI's unit, isImported false, UI defaults
// for everything the caller did not supply.
function createData(
  className: string,
  p: Record<string, unknown>,
  ctx: WriteCtx
): Record<string, unknown> {
  const me = agentToDid(ctx.ownAgent);
  switch (className) {
    case "AcornOutcome":
      return {
        content: "",
        description: "",
        githubLink: "",
        tags: [],
        scopeType: "Uncertain",
        ...p,
        creator: me,
        timestampCreated: nowSecs(),
        isImported: false,
      };
    case "AcornConnection":
      return {
        siblingOrder: 0,
        randomizer: Date.now(),
        ...p,
        isImported: false,
      };
    case "AcornEntryPoint":
      return {
        color:
          p.outcome != null
            ? pickColorForString(urlToHash(p.outcome, ctx.lang))
            : "",
        ...p,
        creator: me,
        createdAtTime: Date.now(),
        isImported: false,
      };
    case "AcornOutcomeComment":
      return { ...p, creator: me, unixTimestamp: nowSecs(), isImported: false };
    case "AcornOutcomeMember":
      return { ...p, creator: me, unixTimestamp: nowSecs(), isImported: false };
    case "AcornTag":
      return { backgroundColor: "#fff2d8", ...p };
    case "AcornProjectMeta":
      return {
        name: "",
        layeringAlgorithm: "LongestPath",
        topPriorityOutcomes: [],
        ...p,
        creator: me,
        createdAtTime: Date.now(),
        isImported: false,
      };
    case "AcornProfile":
      return {
        firstName: "",
        lastName: "",
        handle: "",
        status: "Online",
        avatarUrl: "",
        ...p,
        agentPubKey: ctx.ownAgent,
        isImported: false,
      };
    default:
      return { ...p };
  }
}

// ---------------------------------------------------------------------------
// zome functions (see zomes.md)
// ---------------------------------------------------------------------------

// [fetch fn for a fresh read, create fn, update fn, delete fn] per class;
// `null` where the class is read-only on that axis this step.
const FNS: Record<
  string,
  { zome: string; fetch?: string; create?: string; update?: string; del?: string }
> = {
  AcornOutcome: {
    zome: "projects",
    fetch: "fetch_outcomes",
    create: "create_outcome_with_connection",
    update: "update_outcome",
    del: "delete_outcome_fully",
  },
  AcornConnection: {
    zome: "projects",
    fetch: "fetch_connections",
    create: "create_connection",
    update: "update_connection",
    del: "delete_connection",
  },
  AcornEntryPoint: {
    zome: "projects",
    fetch: "fetch_entry_points",
    create: "create_entry_point",
    update: "update_entry_point",
    del: "delete_entry_point",
  },
  AcornOutcomeComment: {
    zome: "projects",
    fetch: "fetch_outcome_comments",
    create: "create_outcome_comment",
    update: "update_outcome_comment",
    del: "delete_outcome_comment",
  },
  AcornOutcomeMember: {
    zome: "projects",
    fetch: "fetch_outcome_members",
    create: "create_outcome_member",
    update: "update_outcome_member",
    del: "delete_outcome_member",
  },
  AcornTag: {
    zome: "projects",
    fetch: "fetch_tags",
    create: "create_tag",
    update: "update_tag",
    del: "delete_tag",
  },
  AcornProjectMeta: {
    zome: "projects",
    fetch: "fetch_project_metas",
    create: "simple_create_project_meta",
    update: "update_project_meta",
  },
  AcornMember: { zome: "projects" },
  AcornProfile: {
    zome: "profiles",
    fetch: "fetch_agents",
    create: "create_whoami",
    // update_whoami exists but is B5's own-key profile write.
  },
};

/** Which write interactions a class offers (create on `class/<Name>`,
 *  update/delete on its records). AcornMember is read-only; AcornProfile's
 *  update is B5, AcornProjectMeta has no destructor in the shapes. */
export function writeCaps(className: string): {
  create: boolean;
  update: boolean;
  delete: boolean;
} {
  const fns = FNS[className];
  return {
    create: !!fns?.create,
    update: !!fns?.update,
    delete: !!fns?.del,
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export async function createRecord(
  className: string,
  params: Record<string, unknown>,
  ctx: WriteCtx
): Promise<MountDelta> {
  if (!isClassName(className)) {
    throw new Error(`create: unknown class ${className}`);
  }
  const fns = FNS[className];
  if (!fns?.create) throw new Error(`create: ${className} cannot be created`);

  const p = createParams(className, params ?? {});
  const mctx = mapCtx(ctx);
  const touched: string[] = [];
  let address: string;

  try {
    if (className === "AcornOutcome") {
      const entry = toEntry(className, createData(className, p, ctx), mctx);
      // `parent` drives maybeLinkedOutcome — `ExistingOutcomeAsParent` makes
      // the named outcome the new one's parent (outcome/crud.rs:126-134).
      const maybeLinkedOutcome =
        p.parent != null
          ? {
              outcomeActionHash: urlToHash(p.parent, ctx.lang),
              relation: "ExistingOutcomeAsParent",
              siblingOrder: typeof p.siblingOrder === "number" ? p.siblingOrder : 0,
            }
          : null;
      const res = await holochainCall(NICK, fns.zome, fns.create, {
        entry,
        maybeLinkedOutcome,
      });
      address = res.outcome.actionHash;
      touched.push(address);
      if (res.maybeConnection?.actionHash) {
        touched.push(res.maybeConnection.actionHash);
        touched.push(urlToHash(p.parent, ctx.lang));
      }
    } else if (className === "AcornProjectMeta") {
      const entry = toEntry(className, createData(className, p, ctx), mctx);
      const wr = await holochainCall(NICK, fns.zome, fns.create, {
        input: entry,
        local: true,
      });
      address = wr.actionHash;
      touched.push(address);
    } else {
      if (className === "AcornConnection" && (p.parent == null || p.child == null)) {
        throw new Error("AcornConnection needs parent and child URLs");
      }
      if (
        (className === "AcornEntryPoint" ||
          className === "AcornOutcomeComment" ||
          className === "AcornOutcomeMember") &&
        p.outcome == null
      ) {
        throw new Error(`${className} needs an outcome URL`);
      }
      if (className === "AcornOutcomeMember" && p.member == null) {
        throw new Error("AcornOutcomeMember needs a member did");
      }
      const entry = toEntry(className, createData(className, p, ctx), mctx);
      const wr = await holochainCall(NICK, fns.zome, fns.create, entry);
      if (className === "AcornProfile") {
        address = `profile/${entry.agentPubKey}`;
      } else {
        address = wr.actionHash;
      }
      touched.push(address);
      if (className === "AcornConnection") {
        // both ends' parent/children views changed
        touched.push(urlToHash(p.parent, ctx.lang), urlToHash(p.child, ctx.lang));
      }
    }
  } catch (e) {
    const m = msg(e);
    throw new Error(m.startsWith("create:") ? m : `create: ${m}`);
  }

  const snap = await takeSnapshot(ctx.lang);
  return { address, changed: pickEntries(snap, touched), removed: [] };
}

// ---------------------------------------------------------------------------
// interaction metadata
// ---------------------------------------------------------------------------

const PARAM_TYPES: Record<string, string> = {
  siblingOrder: "number",
  randomizer: "number",
  unixTimestamp: "number",
  timestampCreated: "number",
  timestampUpdated: "number",
  createdAtTime: "number",
  targetDate: "number",
  smallsEstimate: "number",
  inBreakdown: "boolean",
  isImported: "boolean",
  tags: "string[]",
  children: "string[]",
  topPriorityOutcomes: "string[]",
};

function paramType(name: string): string {
  return PARAM_TYPES[name] ?? "string";
}

/** `create` parameters for `class/<ClassName>`: the shape's writable props
 *  plus AcornOutcome's parent/siblingOrder (needed to link a new outcome
 *  under an existing one — see createRecord). */
export function createParameters(
  className: string
): { name: string; type: string }[] {
  const params = writablePropNames(className).map((name) => ({
    name,
    type: paramType(name),
  }));
  for (const extra of CREATE_EXTRA[className] ?? []) {
    if (!params.some((p) => p.name === extra)) {
      params.push({ name: extra, type: paramType(extra) });
    }
  }
  return params;
}

/** `update` parameters for a record: the shape's writable props. */
export function updateParameters(
  className: string
): { name: string; type: string }[] {
  return writablePropNames(className).map((name) => ({
    name,
    type: paramType(name),
  }));
}
