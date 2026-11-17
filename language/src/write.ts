// B3 write side: the `create` / `update` / `delete` interactions the B2
// shapes point to (design §3.3–3.4). Each one makes the Acorn zome call,
// refreshes the module-level snapshot, and answers the mount delta
// `{ address, changed, removed }` — addresses without the `<lang>://` prefix.
//
// Zome call shapes are documented in zomes.md. Entries carry ActionHashB64 /
// AgentPubKeyB64 strings end to end (no binary crossing).

import { agentToDid, didToAgent } from "./agent";
import {
  mergeForUpdate,
  toEntry,
  urlToHash,
  type MapCtx,
  type ToEntryCtx,
} from "./mapping";
import { lastSnapshot, type SnapshotEntry } from "./state";
import { isClassName, writablePropNames } from "./shapes";

/** What an interaction needs besides the caller's params. */
export interface WriteCtx {
  /** this language's address */
  lang: string;
  /** the language cell's own AgentPubKeyB64 */
  ownAgent: string;
  /** the executor's AD4M DID — the own member's sameAs (Correction 15) */
  ad4mDid: string;
  /** the project network seed (template banner) */
  seed: string;
  /** a zome call on the projects DNA — production wires
   *  `holochainCall(NICK, …)`; the unit tests inject a table (B6). */
  call: (zome: string, fn: string, payload: unknown) => Promise<any>;
  /** a fresh mount snapshot — production wires `takeSnapshot`. */
  snapshot: () => Promise<{ entries: SnapshotEntry[] }>;
  /** post-commit reconciliation budget for a create: how long (wall
   *  clock) to keep re-reading the snapshot for the committed record, and
   *  the pause between reads (defaults 10 s / 500 ms). */
  reconcileMs?: number;
  reconcileDelayMs?: number;
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
    ownAgent: ctx.ownAgent,
    ad4mDid: ctx.ad4mDid,
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
  return [...new Set(addrs)]
    .map((a) => byAddr.get(a))
    .filter((e): e is SnapshotEntry => e != null);
}

// The mount's canonical address for a created record (B6, Lal P2):
// hdk_crud's do_create always commits a NEW action and returns its hash,
// but fetch_* lists one record per ENTRY under the ORIGINAL create action
// (get_latest_for_entry → details.actions.first()) — an identical
// re-create answers an actionHash the mount never lists. Reconcile against
// the fresh snapshot by entryHash (the mounted identity). No match = not
// mounted: null, never the raw hash (Lal round 2, #4).
function mountedAddr(
  snap: { entries: SnapshotEntry[] },
  created: { actionHash: string; entryHash?: unknown }
): string | null {
  if (typeof created.entryHash === "string") {
    const hit = snap.entries.find((e) => e.data?.entryHash === created.entryHash);
    if (hit) return hit.address;
  }
  return snap.entries.some((e) => e.address === created.actionHash)
    ? created.actionHash
    : null;
}

// Key-order-insensitive JSON for comparing a would-be entry with a fetched
// one (undefined fields dropped, as msgpack drops them).
function canonJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .filter((k) => x[k] !== undefined)
            .map((k) => [k, x[k]])
        )
      : x
  );
}

// Creates are serialized per class (module-wide: every interaction's
// WriteCtx shares it), so two concurrent identical creates cannot both
// commit — the second sees the first's record in its pre-commit read.
const createLocks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = createLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  createLocks.set(key, tail);
  tail.then(() => {
    if (createLocks.get(key) === tail) createLocks.delete(key);
  });
  return run;
}

/** A create committed on the DHT whose record the mount does not list
 *  within the reconciliation budget. NOT retryable: the mutation already
 *  happened — `committed` names its action hashes; the record mounts on
 *  the next resync that lists it. */
export class CommittedNotMountedError extends Error {
  committed: string[];
  constructor(committed: string[], ms: number, cause?: unknown) {
    super(
      `create: committed ${committed.join(", ")} but the mount does not ` +
        `list it after ${ms} ms${cause ? ` (last read: ${msg(cause)})` : ""}; ` +
        `do not retry the create — it mounts with the next resync`
    );
    this.committed = committed;
  }
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
    // whoami is the update read: fetch_agents is bare Profiles, and only
    // the own profile is writable (Correction 6).
    update: "update_whoami",
  },
};

/** Which write interactions a class offers (create on `class/<Name>`,
 *  update/delete on its records). AcornMember is read-only; AcornProfile
 *  updates only on profile/<own key> (gated in interactions()); and
 *  AcornProjectMeta has no destructor in the shapes. */
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
  return serialized(className, () => createLocked(className, fns, params, ctx));
}

// Concurrent identical creates (Lal round 2, #4) — the defined behaviour:
// creates of one class run one at a time; before committing, a class
// whose entry carries no per-call stamp (tags, connections, …) reads its
// collection and, when a record with a byte-identical entry already
// exists, answers that record's mounted address WITHOUT a new commit. So
// two identical creates from this agent yield one action and one stable
// URL. Identical entries committed by OTHER agents still give one entry
// several create actions; the mounted URL is then whichever action
// fetch_* lists (details.actions.first()), and the URL an earlier create
// answered can be replaced by another at a later resync.
async function createLocked(
  className: string,
  fns: (typeof FNS)[string],
  params: Record<string, unknown>,
  ctx: WriteCtx
): Promise<MountDelta> {
  const p = createParams(className, params ?? {});
  const mctx = mapCtx(ctx);
  const touched: string[] = [];
  // Every created WireRecord as {actionHash, entryHash}; reconciled to the
  // canonical mount addresses once the fresh snapshot is in (mountedAddr).
  const created: { actionHash: string; entryHash?: unknown }[] = [];
  let profileAddress: string | null = null;

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
      const res = await ctx.call(fns.zome, fns.create!, {
        entry,
        maybeLinkedOutcome,
      });
      created.push(res.outcome);
      if (res.maybeConnection?.actionHash) {
        created.push(res.maybeConnection);
        touched.push(urlToHash(p.parent, ctx.lang));
      }
    } else if (className === "AcornProjectMeta") {
      const entry = toEntry(className, createData(className, p, ctx), mctx);
      const wr = await ctx.call(fns.zome, fns.create!, {
        input: entry,
        local: true,
      });
      created.push(wr);
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
      const same =
        className !== "AcornProfile" && fns.fetch
          ? await identicalRecord(ctx, fns.zome, fns.fetch, entry)
          : null;
      const wr = same ?? (await ctx.call(fns.zome, fns.create!, entry));
      if (className === "AcornProfile") {
        // a profile mounts under its author key, not an action hash
        profileAddress = `profile/${entry.agentPubKey}`;
      } else {
        created.push(wr);
      }
      if (className === "AcornConnection") {
        // both ends' parent/children views changed
        touched.push(urlToHash(p.parent, ctx.lang), urlToHash(p.child, ctx.lang));
      }
    }
  } catch (e) {
    const m = msg(e);
    throw new Error(m.startsWith("create:") ? m : `create: ${m}`);
  }

  if (!profileAddress && !created.some((c) => c?.actionHash)) {
    throw new Error("create: the zome returned no record");
  }

  // Post-commit reconciliation: re-read the snapshot (never the mutation)
  // until every committed record is mounted, within a wall-clock budget.
  // A failed read is retried like a miss; on timeout the create rejects
  // with CommittedNotMountedError — success is never reported with an
  // address the mount does not list.
  const budget = Math.max(0, ctx.reconcileMs ?? 10000);
  const pause = Math.max(0, ctx.reconcileDelayMs ?? 500);
  const t0 = Date.now();
  let lastErr: unknown = null;
  for (;;) {
    try {
      const snap = await ctx.snapshot();
      const addrs = profileAddress
        ? snap.entries.some((e) => e.address === profileAddress)
          ? [profileAddress]
          : [null]
        : created.map((c) => mountedAddr(snap, c));
      if (addrs.every((a): a is string => a != null)) {
        return {
          address: addrs[0],
          changed: pickEntries(snap, [...addrs, ...touched]),
          removed: [],
        };
      }
      lastErr = null;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() - t0 >= budget) {
      const committed = profileAddress
        ? [profileAddress]
        : created.map((c) => c.actionHash);
      throw new CommittedNotMountedError(committed, Date.now() - t0, lastErr);
    }
    await new Promise((r) => setTimeout(r, pause));
  }
}

// The already-existing record whose entry equals `entry`, from a local
// read of the class's collection, as {actionHash, entryHash}; null when
// none (or the read fails — the create then commits as before).
async function identicalRecord(
  ctx: WriteCtx,
  zome: string,
  fetchFn: string,
  entry: unknown
): Promise<{ actionHash: string; entryHash?: unknown } | null> {
  let rows: unknown;
  try {
    rows = await ctx.call(zome, fetchFn, { input: { All: null }, local: true });
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const want = canonJson(entry);
  const hit = rows.find(
    (r: any) => typeof r?.actionHash === "string" && canonJson(r.entry) === want
  );
  return hit ? { actionHash: hit.actionHash, entryHash: hit.entryHash } : null;
}

// ---------------------------------------------------------------------------
// update = read-modify-write (design §3.3)
// ---------------------------------------------------------------------------

// Lower-cased class name minus the Acorn prefix, for `… not found` errors.
function label(className: string): string {
  const s = className.startsWith("Acorn") ? className.slice(5) : className;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export async function updateRecord(
  className: string,
  address: string,
  params: Record<string, unknown>,
  ctx: WriteCtx
): Promise<MountDelta> {
  const fns = FNS[className];
  if (!fns?.update || !fns.fetch) {
    throw new Error(`update: ${className} has no update`);
  }

  // read the current entry — `All` + an actionHash match serves every class
  // except AcornProfile, whose address is profile/<key> and whose only
  // writable record is the own one: whoami is its read (Correction 6).
  let current: any;
  let updateHash = address;
  try {
    if (className === "AcornProfile") {
      if (address !== `profile/${ctx.ownAgent}`) {
        throw new Error("only the own profile can be updated");
      }
      current = await ctx.call(fns.zome, "whoami", {
        input: null,
        local: true,
      });
      if (!current) {
        throw new Error("no own profile — create one first");
      }
      updateHash = current.actionHash;
    } else {
      const records =
        (await ctx.call(fns.zome, fns.fetch, {
          input: { All: null },
          local: true,
        })) ?? [];
      current = records.find((r: any) => r?.actionHash === address);
    }
  } catch (e) {
    throw new Error(`update: ${msg(e)}`);
  }
  if (!current) {
    throw new Error(`update: ${label(className)} ${address} not found`);
  }

  // B6, Lal P2: a connection update moves its endpoints — the OLD outcomes
  // lose a parent/children edge and the NEW ones gain it, so both sides'
  // mounted data changes. Capture the endpoints from the fetched current
  // record before the write; the new ones come from the merged entry below.
  const oldEnds =
    className === "AcornConnection"
      ? [current.entry?.parentActionHash, current.entry?.childActionHash]
      : [];

  let entry: Record<string, unknown>;
  try {
    entry = mergeForUpdate(className, current.entry, params ?? {}, mapCtx(ctx));
    if (className === "AcornOutcome") {
      // the Acorn UI stamps every outcome update with the editing agent and
      // moment().unix() — the two fields a full-entry compare must allow.
      entry.editorAgentPubKey = ctx.ownAgent;
      entry.timestampUpdated = nowSecs();
    }
    if (className === "AcornProjectMeta") {
      // never derived from mounted data; keep the stored passphrase.
      entry.passphrase = current.entry.passphrase;
    }
  } catch (e) {
    throw new Error(`update: ${msg(e)}`);
  }

  try {
    await ctx.call(fns.zome, fns.update, {
      entry,
      actionHash: updateHash,
    });
  } catch (e) {
    throw new Error(`update: ${msg(e)}`);
  }

  const touched: unknown[] = [address];
  if (className === "AcornConnection") {
    touched.push(...oldEnds, entry.parentActionHash, entry.childActionHash);
  }
  const snap = await ctx.snapshot();
  return {
    address,
    changed: pickEntries(
      snap,
      touched.filter((a): a is string => typeof a === "string")
    ),
    removed: [],
  };
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export async function deleteRecord(
  className: string,
  address: string,
  ctx: WriteCtx
): Promise<MountDelta> {
  const fns = FNS[className];
  if (!fns?.del) throw new Error(`delete: ${className} has no delete`);

  // Records whose mounted data changes when this one disappears: an
  // outcome's former parent (children loses it) and children (parent
  // clears); a connection's two ends. `removed` only strips the deleted
  // record's own links, so the delta must re-expand these.
  const pre = lastSnapshot.get(address)?.data ?? {};
  const touched: string[] = [];
  const parent = pre.parent != null ? urlToHash(pre.parent, ctx.lang) : null;
  const child = pre.child != null ? urlToHash(pre.child, ctx.lang) : null;
  if (className === "AcornOutcome") {
    if (parent) touched.push(parent);
    for (const c of Array.isArray(pre.children) ? pre.children : []) {
      touched.push(urlToHash(c, ctx.lang));
    }
  } else if (className === "AcornConnection") {
    if (parent) touched.push(parent);
    if (child) touched.push(child);
  }

  let removed: string[];
  try {
    if (className === "AcornOutcome") {
      // delete_outcome_fully also removes the connections, members,
      // comments and entry points attached to the outcome — the mount's
      // `removed` must list every one (votes are not mounted).
      const res = await ctx.call(fns.zome, fns.del, {
        input: address,
        local: true,
      });
      removed = [
        address,
        ...(res.deletedConnections ?? []),
        ...(res.deletedOutcomeMembers ?? []),
        ...(res.deletedOutcomeComments ?? []),
        ...(res.deletedEntryPoints ?? []),
      ];
    } else {
      await ctx.call(fns.zome, fns.del, address);
      removed = [address];
    }
  } catch (e) {
    throw new Error(`delete: ${msg(e)}`);
  }

  const snap = await ctx.snapshot();
  return {
    address,
    changed: pickEntries(
      snap,
      touched.filter((a) => !removed.includes(a))
    ),
    removed,
  };
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
