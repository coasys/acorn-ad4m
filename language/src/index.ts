import {
  holochainRegisterDnas,
  holochainCall,
  agentDid,
  emitSignal,
  languageAddress,
} from "ad4m:host";
import {
  bytesToB64,
  stdB64ToBytes,
  deepDecode,
  deepEncode,
} from "./holo";
import { agentToDid } from "./agent";
import { toData } from "./mapping";
import { isClassName, mountShapesFor } from "./shapes";
import { lastSnapshot, mountState } from "./state";
import { resyncSnapshot, takeSnapshot } from "./snapshot";
import { decodeSignalEnvelope, FETCH_SPEC, type FetchKind } from "./signals";
import { Reconciler } from "./reconcile";
import {
  createParameters,
  createRecord,
  deleteRecord,
  updateParameters,
  updateRecord,
  writeCaps,
  type WriteCtx,
} from "./write";

// Filled by the two template-banner lines at the top of the built bundle:
//   //!@ad4m-template-variable
//   const seed = "";
// `language.applyTemplateLocal` rewrites that line with the project seed.
declare const seed: string;

// Build-time constants injected by build.mjs (esbuild `define`).
declare const ACORN_HAPP_B64: string;
declare const ACORN_DEBUG_CALL: boolean;

export const name = "acorn";
export const version = "0.0.1";

const NICK = "projects";
let appInfo: any = null;

export async function init(): Promise<void> {
  if (seed === "") {
    throw new Error("acorn language: no seed; apply the template first");
  }
  const [info] = await holochainRegisterDnas([
    {
      nick: NICK,
      file: stdB64ToBytes(ACORN_HAPP_B64),
      network_seed: seed,
    },
  ]);
  appInfo = info;
}

export async function teardown(): Promise<void> {}

export function isPublic(): boolean {
  return false;
}

// B4: an Acorn remote signal becomes a mount delta (design §1.5). The
// executor hands us { cell_id, zome_name, payload } with payload still
// msgpack (test/fixtures/raw-signal.md). B6/B7: the signal is only an
// invalidation hint — it marks records dirty in the one Reconciler
// (reconcile.ts), which re-reads them through the same zome calls the
// snapshot uses, applies through the mount state's revision guard and
// pushes `{ mountDelta }` — every perspective mounting this language
// applies it (ad4m_signal_emitted's mountDelta branch). Our own writes
// echo back through this path too (get_peers includes the sender) and
// are a no-op: the guard drops a re-read identical to what is mounted.
//
// The worker only starts once the first snapshot has run; hints that land
// before are queued dirty (bounded — a pre-mount burst overflows into "the
// first snapshot covers it") and reconciled right after it, so a change
// made while the first snapshot was reading is not lost until the resync
// (Lal round 2, remaining checks).
let hasMounted = false;

// Verified-collection read for the worker: a NETWORK get — a signal
// routinely lands BEFORE gossip delivers the op; GetStrategy::Network
// queries the DHT now (the snapshot's bulk reads stay local). The worker
// fetches each collection once per pass, so no caching here.
async function fetchRows(kind: FetchKind): Promise<any[]> {
  const spec = FETCH_SPEC[kind];
  const res = await holochainCall(NICK, spec.zome, spec.fn, {
    input: spec.input,
    local: false,
  });
  return Array.isArray(res) ? res : res == null ? [] : [res];
}

// created on first use: languageAddress() is a host call
let worker: Reconciler | null = null;
function reconciler(): Reconciler {
  worker ??= new Reconciler({
    lang: languageAddress(),
    state: mountState,
    fetch: fetchRows,
    emit: (delta) => emitSignal({ mountDelta: delta }),
    resync: async () =>
      (await resyncSnapshot(languageAddress(), snapshotIdentity())).delta,
    identity: snapshotIdentity,
  });
  return worker;
}

export async function handleHolochainSignal(signal: any): Promise<void> {
  try {
    const decoded = decodeSignalEnvelope(signal?.payload);
    if (!decoded) return;
    reconciler().hint(decoded);
  } catch (e) {
    console.error("handleHolochainSignal:", e);
  }
}

// --- Mount contract (B2 read side; see spec/09-b2-read-side.md) ---

export async function mountShapes(): Promise<object> {
  return mountShapesFor(languageAddress());
}

// Identity the snapshot needs for the own member's sameAs (Correction 15):
// the language cell's key and the executor's AD4M DID.
function snapshotIdentity() {
  return { ownAgent: ownAgentKey(), ad4mDid: agentDid() };
}

export async function mountSnapshot(): Promise<object> {
  const { entries, seq } = await resyncSnapshot(
    languageAddress(),
    snapshotIdentity()
  );
  if (!hasMounted) {
    hasMounted = true;
    reconciler().start(seq);
  } else {
    reconciler().coveredBy(seq);
  }
  return { entries };
}

export async function expressionGet(address: string): Promise<object | null> {
  // `address` is the URL path — the create action hash, or `profile/<key>`.
  if (!lastSnapshot.has(address)) {
    try {
      await mountSnapshot();
    } catch {
      // fall through; a failed refresh still answers from the last snapshot
    }
  }
  const hit = lastSnapshot.get(address);
  if (!hit) return null;
  const { data } = hit;
  // WireRecord.createdAt is a Holochain Timestamp in microseconds; divide by
  // 1000 to get Date's milliseconds (verified on the rig — see REPORT-b2.md).
  const ts =
    typeof data.recordCreatedAt === "number"
      ? new Date(data.recordCreatedAt / 1000).toISOString()
      : null;
  return {
    author: (data.creator as string) ?? null,
    timestamp: ts,
    data,
    proof: { signature: "", key: "", valid: false, invalid: true },
  };
}

interface InteractionParameter {
  name: string;
  type: string;
}
interface Interaction {
  name: string;
  label: string;
  parameters: InteractionParameter[];
  execute: (params: any) => Promise<any>;
}

// cell_info[NICK][0] is { provisioned | cloned | stem: { cell_id } };
// cell_id is [dnaHash: Uint8Array(39), agentPubKey: Uint8Array(39)].
function cellIdB64(): [string, string] | null {
  const infos = appInfo?.cell_info?.[NICK];
  const first = infos?.[0];
  const inner = first?.provisioned ?? first?.cloned ?? first?.stem ?? first?.value;
  const id = inner?.cell_id;
  if (!id) return null;
  return [bytesToB64(id[0]), bytesToB64(id[1])];
}

// The language cell's own Holochain agent key (AgentPubKeyB64): the AD4M
// user's Acorn identity — `did:key` of these 32 bytes is what other users
// see as `creator`/`agent` (design §5.3).
function ownAgentKey(): string {
  return (
    cellIdB64()?.[1] ??
    (appInfo?.agent_pub_key ? bytesToB64(appInfo.agent_pub_key) : "")
  );
}

async function info(): Promise<any> {
  const cell = cellIdB64();
  const key = ownAgentKey();
  return {
    dnaHash: cell ? cell[0] : null,
    agentPubKey: key || null,
    agentDid: key ? agentToDid(key) : null,
    ad4mDid: agentDid(),
    seed,
    cellId: cell,
  };
}

// `whoami` answers the own Acorn profile in the mount's shape —
// { address: "profile/<own key>", data } or null until create_whoami ran
// (the UI's setProjectWhoami, installProject.ts).
async function projectWhoami(): Promise<any> {
  const key = ownAgentKey();
  if (!key) return null;
  const wr = await holochainCall(NICK, "profiles", "whoami", {
    input: null,
    local: true,
  });
  if (!wr) return null;
  const lang = languageAddress();
  const data = toData("AcornProfile", wr.entry, {
    lang,
    hashToUrl: (h) => `${lang}://${h}`,
    agentToDid,
  });
  return { address: `profile/${key}`, data };
}

function writeCtx(): WriteCtx {
  const lang = languageAddress();
  return {
    lang,
    ownAgent: ownAgentKey(),
    ad4mDid: agentDid(),
    seed,
    call: (zome, fn, payload) => holochainCall(NICK, zome, fn, payload),
    snapshot: () => takeSnapshot(lang, snapshotIdentity()),
  };
}

export async function interactions(address: string): Promise<Interaction[]> {
  if (address === "project") {
    const list: Interaction[] = [
      {
        name: "info",
        label: "Acorn project cell info",
        parameters: [],
        execute: () => info(),
      },
      {
        name: "whoami",
        label: "The own Acorn profile in this project",
        parameters: [],
        execute: () => projectWhoami(),
      },
      {
        name: "sendRealtimeInfo",
        label: "Send realtime presence info to project peers",
        parameters: [
          { name: "projectId", type: "string" },
          { name: "outcomeBeingEdited", type: "object" },
          { name: "outcomeExpandedView", type: "string" },
        ],
        // params pass through verbatim — they ARE the zome's
        // RealtimeInfoInput (projects/src/lib.rs:152).
        execute: async (p: any) => {
          await holochainCall(
            NICK,
            "projects",
            "emit_realtime_info_signal",
            p ?? null
          );
          return null;
        },
      },
      {
        name: "announceJoin",
        label: "Signal project peers that we joined",
        parameters: [],
        // the UI's triggerJoinSignal (joinProject.ts): init_signal sends a
        // Member signal to every peer so they learn we are here.
        execute: async () => {
          await holochainCall(NICK, "projects", "init_signal", null);
          return null;
        },
      },
    ];
    if (ACORN_DEBUG_CALL) {
      list.push({
        name: "call",
        label: "Holochain zome call (debug build only)",
        parameters: [
          { name: "zome", type: "string" },
          { name: "fn", type: "string" },
          { name: "payload", type: "object" },
        ],
        execute: async (p: any) =>
          deepEncode(
            await holochainCall(NICK, p.zome, p.fn, deepDecode(p?.payload ?? null))
          ),
      });
    }
    return list;
  }

  // `class/<ClassName>`: the constructor target the shapes name.
  if (address.startsWith("class/")) {
    const className = address.slice("class/".length);
    if (!isClassName(className) || !writeCaps(className).create) return [];
    const ctx = writeCtx();
    return [
      {
        name: "create",
        label: `Create ${className.slice("Acorn".length)}`,
        parameters: createParameters(className),
        execute: (params: any) => createRecord(className, params ?? {}, ctx),
      },
    ];
  }

  // A mounted record address: update/delete per the class's write fns
  // (wired in the update and delete steps below). Unknown addresses get
  // one snapshot refresh before answering empty.
  let hit = lastSnapshot.get(address);
  if (!hit) {
    try {
      await takeSnapshot(languageAddress(), snapshotIdentity());
    } catch {
      // a failed refresh still answers from the last snapshot
    }
    hit = lastSnapshot.get(address);
  }
  if (!hit) return [];
  const caps = writeCaps(hit.class);
  const ctx = writeCtx();
  const list: Interaction[] = [];
  // AcornProfile: whoami/update_whoami only ever touch the caller's own
  // profile, so `update` exists only on profile/<own key>; any other
  // profile has no interactions (Correction 6).
  const updatable =
    caps.update &&
    (hit.class !== "AcornProfile" || address === `profile/${ctx.ownAgent}`);
  if (updatable) {
    list.push({
      name: "update",
      label: `Update ${hit.class.slice("Acorn".length)}`,
      parameters: updateParameters(hit.class),
      execute: (params: any) =>
        updateRecord(hit.class, address, params ?? {}, ctx),
    });
  }
  if (caps.delete) {
    list.push({
      name: "delete",
      label: `Delete ${hit.class.slice("Acorn".length)}`,
      parameters: [],
      execute: () => deleteRecord(hit.class, address, ctx),
    });
  }
  return list;
}
