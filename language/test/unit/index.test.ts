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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CONNECTION_AB,
  connectionEntry,
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
async function loadLanguage(
  defines: Record<string, string> = {},
  entry = join(HERE, "..", "..", "src", "index.ts")
): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "acorn-index-"));
  const stub = join(dir, "host.mjs");
  writeFileSync(stub, HOST_STUB);
  const out = join(dir, "index.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    outfile: out,
    banner: { js: 'const seed = "test-seed";' },
    define: {
      ACORN_HAPP_B64: '""',
      ACORN_DEBUG_CALL: "false",
      ACORN_MOUNT_RESYNC: "true",
      ACORN_TEST_BUILD: "false",
      ...defines,
    },
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

// ---- periodic resync switch (Lal round 2, P2 #5) ---------------------------
//
// The executor re-runs mountSnapshot every 15 s (its interval is fixed in
// the binary). With the language's periodic resync OFF, every mountSnapshot
// after the first answers the mount as signals left it, without reading —
// so a rig can prove the push path with no resync behind it.

function countingHost(host: Host) {
  installHost(host);
  const h = (globalThis as any).__acornHost;
  const calls = { local: 0 };
  const inner = h.holochainCall;
  h.holochainCall = (n: string, z: string, fn: string, p: any) => {
    if (p?.local !== false) calls.local++;
    return inner(n, z, fn, p);
  };
  return calls;
}

test("test build — mountResync off: later mountSnapshots answer the mount without reading", async () => {
  const host: Host = { local: { outcomes: [outcomeA()] }, network: {}, emitted: [] };
  const calls = countingHost(host);
  const lang = await loadLanguage({ ACORN_TEST_BUILD: "true" });
  await lang.mountSnapshot();
  const project = await lang.interactions("project");
  const sw = project.find((i: any) => i.name === "mountResync");
  assert.ok(sw, "no mountResync interaction on project");
  assert.deepEqual(await sw.execute({ enabled: false }), { enabled: false });
  const before = calls.local;
  host.local.outcomes = [outcomeB()]; // the zomes changed; no signal
  const { entries } = await lang.mountSnapshot();
  assert.equal(calls.local, before, "resync off still read the zomes");
  assert.deepEqual(entries.map((e: any) => e.address), [OUTCOME_A]);
  // on again: the next mountSnapshot reads and converges
  assert.deepEqual(await sw.execute({ enabled: true }), { enabled: true });
  const again = await lang.mountSnapshot();
  // B arrives; A is only on its first absence strike (F1: removal needs
  // two complete absent reads 15 s apart)
  assert.deepEqual(again.entries.map((e: any) => e.address).sort(), [OUTCOME_A, OUTCOME_B].sort());
});

test("test build — ACORN_MOUNT_RESYNC=off at build time starts with the resync off", async () => {
  const host: Host = { local: { outcomes: [outcomeA()] }, network: {}, emitted: [] };
  const calls = countingHost(host);
  const lang = await loadLanguage({ ACORN_MOUNT_RESYNC: "false", ACORN_TEST_BUILD: "true" });
  await lang.mountSnapshot(); // the first snapshot always reads
  const after = calls.local;
  assert.ok(after > 0);
  host.local.outcomes = [];
  await lang.mountSnapshot();
  assert.equal(calls.local, after);
  const sw = (await lang.interactions("project")).find((i: any) => i.name === "mountResync");
  assert.deepEqual(await sw?.execute({}), { enabled: false });
});

// ---- production builds ignore the switch (Lal round 3, F5) -----------------
//
// The resync is the only path that removes records; a caller of project
// interactions must not be able to turn deletion recovery off in a
// production bundle, and a build env var must not either.

async function assertResyncAlwaysOn(lang: any, host: Host, calls: { local: number }) {
  const project = await lang.interactions("project");
  assert.equal(
    project.find((i: any) => i.name === "mountResync"),
    undefined,
    "production build exposes mountResync"
  );
  await lang.mountSnapshot();
  const before = calls.local;
  host.local.outcomes = [];
  await lang.mountSnapshot();
  assert.ok(calls.local > before, "production build skipped the resync read");
}

test("production build (stub): no mountResync, ACORN_MOUNT_RESYNC=false ignored", async () => {
  const host: Host = { local: { outcomes: [outcomeA()] }, network: {}, emitted: [] };
  const calls = countingHost(host);
  const lang = await loadLanguage({ ACORN_MOUNT_RESYNC: "false", ACORN_TEST_BUILD: "false" });
  await assertResyncAlwaysOn(lang, host, calls);
});

test("production artifact: `ACORN_MOUNT_RESYNC=off node build.mjs` keeps the resync on", async () => {
  const root = join(HERE, "..", "..");
  const env = { ...process.env, ACORN_MOUNT_RESYNC: "off" };
  delete (env as any).ACORN_TEST_BUILD;
  delete (env as any).ACORN_DEBUG_CALL;
  try {
    execFileSync("node", ["build.mjs"], { cwd: root, env, stdio: "pipe" });
    const src = readFileSync(join(root, "build", "bundle.js"), "utf8");
    const dir = mkdtempSync(join(tmpdir(), "acorn-prod-"));
    writeFileSync(join(dir, "host.mjs"), HOST_STUB);
    const out = join(dir, "bundle.mjs");
    writeFileSync(
      out,
      src
        .replace('const seed = "";', 'const seed = "test-seed";')
        .replace(/from\s*["']ad4m:host["']/g, `from ${JSON.stringify(join(dir, "host.mjs"))}`)
    );
    const host: Host = { local: { outcomes: [outcomeA()] }, network: {}, emitted: [] };
    const calls = countingHost(host);
    const lang = await import(pathToFileURL(out).href);
    await assertResyncAlwaysOn(lang, host, calls);
  } finally {
    // leave the default production bundle behind
    const clean = { ...process.env };
    delete (clean as any).ACORN_MOUNT_RESYNC;
    delete (clean as any).ACORN_TEST_BUILD;
    execFileSync("node", ["build.mjs"], { cwd: root, env: clean, stdio: "pipe" });
  }
});

// ---- removal only after repeated complete absence (Lal round 3, F1) --------

const fakeAddr = (i: number) => `uhCkkFAKE${String(i).padStart(6, "0")}`;

test("an overflow burst of peer hints removes nothing", async () => {
  const host: Host = {
    local: { outcomes: [outcomeA()] },
    network: { outcomes: [], connections: [] },
    emitted: [],
  };
  installHost(host);
  const lang = await loadLanguage();
  await lang.mountSnapshot();
  host.local.outcomes = []; // the local view lost A (gossip / dropped error)
  for (let burst = 0; burst < 3; burst++) {
    for (let i = 0; i < 300; i++) {
      await lang.handleHolochainSignal(
        createHint(wireRecord(smallOutcomeEntry(), { actionHash: fakeAddr(burst * 1000 + i) }))
      );
    }
    await sleep(50);
  }
  await sleep(200);
  const removed = host.emitted.flatMap((s) => s.mountDelta?.removed ?? []);
  assert.deepEqual(removed, [], "an overflow resync removed records");
  assert.ok(await lang.expressionGet(OUTCOME_A), "A gone after the overflow bursts");
});

test("write-path / unknown-address refreshes remove nothing immediately", async () => {
  const host: Host = { local: { outcomes: [outcomeA()] }, network: {}, emitted: [] };
  installHost(host);
  const lang = await loadLanguage();
  await lang.mountSnapshot();
  host.local.outcomes = [];
  assert.deepEqual(await lang.interactions("uhCkkUNKNOWNaddress"), []);
  assert.deepEqual(await lang.interactions("uhCkkUNKNOWNaddress2"), []);
  assert.ok(await lang.expressionGet(OUTCOME_A), "A removed by an unknown-address refresh");
  const { entries } = await lang.mountSnapshot();
  assert.ok(entries.some((e: any) => e.address === OUTCOME_A), "A removed by the next resync");
});

// ---- derived edges from the guarded mount (Lal round 3, F2) ----------------

test("a full read missing a mounted connection keeps the outcomes' edges", async () => {
  const c = wireRecord(connectionEntry(), { actionHash: CONNECTION_AB }); // A -> B
  const host: Host = {
    local: { outcomes: [outcomeA(), outcomeB()], connections: [c] },
    network: {},
    emitted: [],
  };
  installHost(host);
  const lang = await loadLanguage();
  const first = await lang.mountSnapshot();
  const b0 = first.entries.find((e: any) => e.address === OUTCOME_B);
  assert.equal(b0?.data.parent, `${LANG}://${OUTCOME_A}`, "precondition: B.parent is A");
  host.local.connections = []; // dropped from the list, not (provably) deleted
  const { entries } = await lang.mountSnapshot();
  const b = entries.find((e: any) => e.address === OUTCOME_B);
  const a = entries.find((e: any) => e.address === OUTCOME_A);
  assert.equal(b?.data.parent, `${LANG}://${OUTCOME_A}`, "B.parent erased by an incomplete list");
  assert.deepEqual(a?.data.children, [`${LANG}://${OUTCOME_B}`]);
  assert.ok(entries.some((e: any) => e.address === CONNECTION_AB), "connection removed on one read");
});

// ---- overflow/resync snapshots cannot leak unsettled calls (Lal round 4, P2-2)
//
// One collection rejects (the aggregate read fails fast) while another
// never settles. Retrying the full read — as the overflow backoff does —
// must not start a new host call for the collection still hung.

test("failed full reads with a hung sibling start no new call for it across retries", async () => {
  const counts: Record<string, number> = {};
  let unsettled = 0;
  (globalThis as any).__acornHost = {
    holochainRegisterDnas: async () => [{}],
    agentDid: () => "did:key:zTestExecutor",
    languageAddress: () => LANG,
    emitSignal: () => {},
    holochainCall: (_n: string, _z: string, fn: string) => {
      counts[fn] = (counts[fn] ?? 0) + 1;
      if (fn === "fetch_tags") return Promise.reject(new Error("tags: source chain error"));
      if (fn === "fetch_outcome_comments") {
        unsettled++;
        return new Promise(() => {}); // hung
      }
      return Promise.resolve(fn === "fetch_project_meta" ? null : []);
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "acorn-snap-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, `export * from ${JSON.stringify(join(HERE, "..", "..", "src", "snapshot.ts"))};`);
  const mod = await loadLanguage({}, entry);
  for (let i = 0; i < 4; i++) {
    await assert.rejects(mod.resyncSnapshot(LANG, {}, { complete: false }), /tags/);
  }
  assert.equal(counts.fetch_outcome_comments, 1, "a new call started for the hung collection");
  assert.equal(unsettled, 1);
  assert.equal(counts.fetch_tags, 4, "the rejected collection is re-read on each retry");
});
