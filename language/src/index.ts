import {
  holochainRegisterDnas,
  holochainCall,
  agentDid,
  languageAddress,
} from "ad4m:host";
import {
  bytesToB64,
  stdB64ToBytes,
  deepDecode,
  deepEncode,
} from "./holo";
import { isClassName, mountShapesFor } from "./shapes";
import { lastSnapshot, takeSnapshot } from "./snapshot";
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

// --- Mount contract (B2 read side; see spec/09-b2-read-side.md) ---

export async function mountShapes(): Promise<object> {
  return mountShapesFor(languageAddress());
}

export async function mountSnapshot(): Promise<object> {
  return takeSnapshot(languageAddress());
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

async function info(): Promise<any> {
  const cell = cellIdB64();
  return {
    dnaHash: cell ? cell[0] : null,
    agentPubKey: cell ? cell[1] : bytesToB64(appInfo?.agent_pub_key),
    agentDid: null, // filled in B5
    ad4mDid: agentDid(),
    seed,
    cellId: cell,
  };
}

function writeCtx(): WriteCtx {
  return {
    lang: languageAddress(),
    ownAgent: cellIdB64()?.[1] ?? "",
    seed,
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
      await takeSnapshot(languageAddress());
    } catch {
      // a failed refresh still answers from the last snapshot
    }
    hit = lastSnapshot.get(address);
  }
  if (!hit) return [];
  const caps = writeCaps(hit.class);
  const ctx = writeCtx();
  const list: Interaction[] = [];
  if (caps.update) {
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
