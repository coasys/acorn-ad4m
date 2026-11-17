// Stock-side driver: a plain Holochain 0.7.0 conductor running the Acorn
// projects DNA — same shape as step-0's scripts/side-b.mjs.
// Usage:
//   node stock.mjs setup   -> install happ, clone cell with $SEED, profile + meta
//   node stock.mjs info    -> {agent, dna} of the stock clone cell
//   node stock.mjs members -> fetch_members on the stock side
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
}

const callZome = (app, cid, zome_name, fn_name, payload) =>
  app.callZome({ cell_id: cid, zome_name, fn_name, payload });

const cmd = process.argv[2];

if (cmd === "setup") {
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
} else if (cmd === "info") {
  const s = loadState();
  console.log(JSON.stringify({ agent: s.agentKeyB64, dna: s.dnaHashB64 }));
  process.exit(0);
} else if (cmd === "members") {
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
} else {
  console.log("usage: setup|info|members");
  process.exit(1);
}
