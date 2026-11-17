import {
  holochainRegisterDnas,
  holochainCall,
  agentDid,
} from "ad4m:host";
import {
  bytesToB64,
  stdB64ToBytes,
  deepDecode,
  deepEncode,
} from "./holo";

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

export function interactions(address: string): Interaction[] {
  if (address !== "project") return [];
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
