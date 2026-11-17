// Stock-side driver: a plain Holochain 0.7.0 conductor running the Acorn
// projects DNA — same shape as step-0's scripts/side-b.mjs.
// Usage:
//   node stock.mjs setup   -> install happ, clone cell with $SEED, profile + meta
//   node stock.mjs info    -> {agent, dna} of the stock clone cell
//   node stock.mjs members -> fetch_members on the stock side
// Tests import connect()/createOutcome()/… and call them on the running rig.
import {
  AdminWebsocket,
  AppWebsocket,
  encodeHashToBase64,
  generateSigningKeyPair,
  setSigningCredentials,
  randomCapSecret,
} from "@holochain/client";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { rigEnv, RUN_DIR, REPO_DIR } from "./envfile.mjs";

const env = rigEnv();
const STATE = join(RUN_DIR, "stock-state.json");
const HAPP = join(REPO_DIR, "language", "vendor", "acorn.happ");
const ADMIN_URL = `ws://127.0.0.1:${env.HC_ADMIN || "45310"}`;
const SEED = env.SEED || "uid-rig-test-project";
const APP_ID = "acorn";

const b64 = (h) => (h && typeof h !== "string" ? encodeHashToBase64(h) : h);
const WS_OPTS = { wsClientOptions: { origin: "acorn-rig" } };

function loadState() {
  return JSON.parse(readFileSync(STATE, "utf8"));
}

async function admin() {
  return await AdminWebsocket.connect({ url: new URL(ADMIN_URL), ...WS_OPTS });
}

// The 0.21.1 client's authorizeSigningCredentials sends a cap-grant shape
// holochain 0.7.0 rejects; grant the signing capability manually with the
// 0.7.0 ZomeCallCapGrant{tag, access, functions} wire shape (as side-b did).
async function signCreds(adminWs, cid) {
  const [keyPair, signingKey] = await generateSigningKeyPair();
  const capSecret = await randomCapSecret();
  await adminWs.grantZomeCallCapability({
    cell_id: cid,
    cap_grant: {
      tag: "zome-call-signing-key",
      access: {
        type: "assigned",
        value: { secret: capSecret, assignees: [signingKey] },
      },
      functions: { type: "all" },
    },
  });
  setSigningCredentials(cid, { capSecret, keyPair, signingKey });
}

async function connectAppAndSign(cid) {
  const adminWs = await admin();
  try {
    await signCreds(adminWs, cid);
    const issued = await adminWs.issueAppAuthenticationToken({
      installed_app_id: APP_ID,
    });
    const s = loadState();
    const app = await AppWebsocket.connect({
      url: new URL(`ws://127.0.0.1:${s.appPort}`),
      token: issued.token,
      ...WS_OPTS,
    });
    return { adminWs, app };
  } catch (e) {
    // A half-open connect leaks the admin ws, which keeps a test-file
    // child process's event loop alive forever after its tests end.
    try { await adminWs?.client?.close(); } catch {}
    throw e;
  }
}

const callZome = (app, cid, zome_name, fn_name, payload) =>
  app.callZome({ cell_id: cid, zome_name, fn_name, payload });

// ---- exported API for rig tests -------------------------------------------
// connect() opens a signed app ws on the stock clone cell from .run state.
// h = { adminWs, app, cid, agent }; close it with closeStock(h).

export async function connect() {
  const s = loadState();
  const cid = [new Uint8Array(s.cellId[0]), new Uint8Array(s.cellId[1])];
  // Test files all call this at once when the suite spawns them together;
  // a concurrent cold-start call can be refused — retry on a fresh socket.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { adminWs, app } = await connectAppAndSign(cid);
      return { adminWs, app, cid, agent: s.agentKeyB64, dna: s.dnaHashB64 };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

export async function closeStock(h) {
  try {
    await h?.app?.client?.close();
  } catch {}
  try {
    await h?.adminWs?.client?.close();
  } catch {}
}

export const stockCall = (h, zome, fn, payload) =>
  callZome(h.app, h.cid, zome, fn, payload);

// A Small-scope outcome entry, the shape Acorn's UI writes.
export function outcomeEntry(agent, content, over = {}) {
  return {
    content,
    creatorAgentPubKey: agent,
    editorAgentPubKey: null,
    timestampCreated: Date.now(),
    timestampUpdated: null,
    scope: {
      Small: { achievementStatus: "NotAchieved", targetDate: null, taskList: [] },
    },
    tags: [],
    description: "",
    isImported: false,
    githubLink: "",
    ...over,
  };
}

// returns the WireRecord {actionHash, entryHash, entry, createdAt, updatedAt}
export function createOutcome(h, content, over) {
  return stockCall(h, "projects", "create_outcome", outcomeEntry(h.agent, content, over));
}

// `ExistingOutcomeAsParent` makes the existing outcome the parent and the new
// one its child (projects/outcome/crud.rs:126-137).
export async function createOutcomeUnder(h, parentActionHash, content, siblingOrder = 0) {
  const res = await stockCall(h, "projects", "create_outcome_with_connection", {
    entry: outcomeEntry(h.agent, content),
    maybeLinkedOutcome: {
      outcomeActionHash: parentActionHash,
      relation: "ExistingOutcomeAsParent",
      siblingOrder,
    },
  });
  return res.outcome;
}

export function createTag(h, text, backgroundColor = "#fff2d8") {
  return stockCall(h, "projects", "create_tag", { backgroundColor, text });
}

// update takes {entry: <new full Outcome>, actionHash: <stable address>}.
// The WireRecord's actionHash is the create hash — the mount address does
// not move on update.
export function updateOutcome(h, actionHash, entry) {
  return stockCall(h, "projects", "update_outcome", { entry, actionHash });
}

export function createComment(h, outcomeActionHash, content) {
  return stockCall(h, "projects", "create_outcome_comment", {
    outcomeActionHash,
    content,
    creatorAgentPubKey: h.agent,
    unixTimestamp: Date.now(),
    isImported: false,
  });
}

// n plain outcomes, sequential (one ws); returns the action hashes.
export async function createOutcomes(h, n, prefix = "perf") {
  const hashes = [];
  for (let i = 0; i < n; i++) {
    const rec = await createOutcome(h, `${prefix} ${i}`);
    hashes.push(rec.actionHash);
  }
  return hashes;
}

// ---- CLI -------------------------------------------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}`;
const cmd = isMain ? process.argv[2] : null;

if (isMain && cmd === "setup") {
  const adminWs = await admin();
  const agentKey = await adminWs.generateAgentPubKey();
  console.log("agent:", b64(agentKey));

  await adminWs.installApp({
    source: { type: "path", value: HAPP },
    agent_key: agentKey,
    installed_app_id: APP_ID,
  });
  await adminWs.enableApp({ installed_app_id: APP_ID });
  const { port } = await adminWs.attachAppInterface({ allowed_origins: "*" });

  const issued = await adminWs.issueAppAuthenticationToken({
    installed_app_id: APP_ID,
  });
  const app = await AppWebsocket.connect({
    url: new URL(`ws://127.0.0.1:${port}`),
    token: issued.token,
    ...WS_OPTS,
  });

  const clone = await app.createCloneCell({
    role_name: "projects",
    modifiers: { network_seed: SEED },
  });
  const cell_id = clone.cell_id;
  console.log("clone cell:", b64(cell_id[0]), b64(cell_id[1]));

  writeFileSync(
    STATE,
    JSON.stringify(
      {
        agentKeyB64: b64(agentKey),
        dnaHashB64: b64(cell_id[0]),
        appPort: port,
        cellId: [Array.from(cell_id[0]), Array.from(cell_id[1])],
      },
      null,
      2
    )
  );

  await signCreds(adminWs, cell_id);

  await callZome(app, cell_id, "profiles", "create_whoami", {
    firstName: "Stock",
    lastName: "Rig",
    handle: "stockrig",
    status: "Online",
    avatarUrl: "",
    agentPubKey: agentKey,
    isImported: false,
  });
  console.log("whoami created");

  await callZome(app, cell_id, "projects", "simple_create_project_meta", {
    input: {
      creatorAgentPubKey: agentKey,
      createdAt: Date.now(),
      name: "Rig Project",
      image: null,
      passphrase: SEED.replace(/^uid-/, "").replace(/-/g, " "),
      isImported: false,
      layeringAlgorithm: "LongestPath",
      topPriorityOutcomes: [],
      isMigrated: null,
    },
    local: true,
  });
  console.log("project meta created");
  process.exit(0);
} else if (isMain && cmd === "info") {
  const s = loadState();
  console.log(JSON.stringify({ agent: s.agentKeyB64, dna: s.dnaHashB64 }));
  process.exit(0);
} else if (isMain && cmd === "members") {
  if (!existsSync(STATE)) throw new Error("no stock state — run setup first");
  const s = loadState();
  const cid = [new Uint8Array(s.cellId[0]), new Uint8Array(s.cellId[1])];
  const { app } = await connectAppAndSign(cid);
  const members = await callZome(app, cid, "projects", "fetch_members", {
    input: null,
    local: false,
  });
  console.log(JSON.stringify(members.map((m) => b64(m.entry.agentPubKey))));
  process.exit(0);
} else if (isMain) {
  console.log("usage: setup|info|members");
  process.exit(1);
}
