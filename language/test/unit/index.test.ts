// index.ts end to end against a stubbed `ad4m:host` (the bundle's only
// external): esbuild builds src/index.ts into a temp module whose host
// calls go to `globalThis.__acornHost`, which each test fills in.
//
// Lal round 2, "Remaining checks": hints that land before the first
// snapshot completes used to be dropped outright, so a change made while
// the collections were being read was missed until the resync.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LANG,
  OUTCOME_A,
  OUTCOME_B,
  smallOutcomeEntry,
  uncertainOutcomeEntry,
  wireRecord,
} from "./fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HOST_STUB = `
const h = () => globalThis.__acornHost;
export const holochainRegisterDnas = (...a) => h().holochainRegisterDnas(...a);
export const holochainCall = (...a) => h().holochainCall(...a);
export const agentDid = () => h().agentDid();
export const emitSignal = (s) => h().emitSignal(s);
export const languageAddress = () => h().languageAddress();
`;

// A fresh copy of the language module (its module state is per import).
async function loadLanguage(defines: Record<string, string> = {}): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "acorn-index-"));
  const stub = join(dir, "host.mjs");
  writeFileSync(stub, HOST_STUB);
  const out = join(dir, "index.mjs");
  await build({
    entryPoints: [join(HERE, "..", "..", "src", "index.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    outfile: out,
    banner: { js: 'const seed = "test-seed";' },
    define: { ACORN_HAPP_B64: '""', ACORN_DEBUG_CALL: "false", ...defines },
    plugins: [
      {
        name: "host-stub",
        setup(b) {
          b.onResolve({ filter: /^ad4m:host$/ }, () => ({ path: stub }));
        },
      },
    ],
    logLevel: "silent",
  });
  return import(pathToFileURL(out).href);
}

const COLLECTIONS: Record<string, string> = {
  fetch_outcomes: "outcomes",
  fetch_connections: "connections",
  fetch_entry_points: "entryPoints",
  fetch_outcome_comments: "comments",
  fetch_outcome_members: "outcomeMembers",
  fetch_tags: "tags",
  fetch_project_metas: "projectMetas",
  fetch_members: "members",
  fetch_agents: "profiles",
};

interface Host {
  local: Record<string, any[]>;
  network: Record<string, any[]>;
  emitted: any[];
  /** called before a local fetch_outcomes answers (to hold it open) */
  onLocalOutcomes?: () => Promise<void>;
}

function installHost(host: Host) {
  (globalThis as any).__acornHost = {
    holochainRegisterDnas: async () => [{}],
    agentDid: () => "did:key:zTestExecutor",
    languageAddress: () => LANG,
    emitSignal: (s: any) => host.emitted.push(s),
    holochainCall: async (_nick: string, _zome: string, fn: string, payload: any) => {
      if (fn === "fetch_project_meta") return null;
      const kind = COLLECTIONS[fn];
      if (!kind) throw new Error(`unexpected zome call ${fn}`);
      if (payload?.local === false) return host.network[kind] ?? [];
      if (kind === "outcomes" && host.onLocalOutcomes) await host.onLocalOutcomes();
      return host.local[kind] ?? [];
    },
  };
}

const outcomeA = () => wireRecord(smallOutcomeEntry(), { actionHash: OUTCOME_A });
const outcomeB = () => wireRecord(uncertainOutcomeEntry(), { actionHash: OUTCOME_B });
const createHint = (rec: any) => ({
  payload: { signalType: "Outcome", data: { entryType: "outcome", action: "create", data: rec } },
});

async function until(pred: () => boolean, ms: number, what: string) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`${what}: not within ${ms} ms`);
    await sleep(5);
  }
}

test("a hint landing during the first snapshot's reads is reconciled after init", async () => {
  // B is created while the mount's first (local) read is in flight; the
  // local read misses it, its create signal arrives mid-read.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const host: Host = {
    local: { outcomes: [outcomeA()] },
    network: { outcomes: [outcomeA(), outcomeB()], connections: [] },
    emitted: [],
    onLocalOutcomes: () => gate,
  };
  installHost(host);
  const lang = await loadLanguage();
  const snap = lang.mountSnapshot();
  await sleep(5);
  await lang.handleHolochainSignal(createHint(outcomeB()));
  release();
  const { entries } = await snap;
  assert.deepEqual(entries.map((e: any) => e.address), [OUTCOME_A]);
  await until(
    () => host.emitted.some((s) => s.mountDelta?.changed?.some((e: any) => e.address === OUTCOME_B)),
    3000,
    "B pushed after init"
  );
});
