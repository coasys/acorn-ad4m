// B4 signals -> mount deltas (spec/11-b4-signals.md). The decoded envelope
// fixtures are written from the Rust signal types
// (happs/happ/zomes/projects/src/lib.rs:43-65, hdk_crud/src/signals.rs:80-86,
// member/entry.rs:8-13, profiles/src/lib.rs:285-307) and the one signal
// captured on the rig (test/fixtures/raw-signal.md).
import test from "node:test";
import assert from "node:assert/strict";
import { agentToDid } from "../../src/agent";
import { deriveRelations, toData, type MapCtx } from "../../src/mapping";
import { signalToDelta, type SignalCtx } from "../../src/signals";
import {
  AGENT_A,
  AGENT_B,
  COMMENT_1,
  CONNECTION_AB,
  ENTRY_HASH,
  LANG,
  MEMBER_1,
  OUTCOME_A,
  OUTCOME_B,
  connectionEntry,
  memberEntry,
  outcomeCommentEntry,
  profileEntry,
  smallOutcomeEntry,
  uncertainOutcomeEntry,
  wireRecord,
} from "./fixtures";

const DID_A = agentToDid(AGENT_A);
const OUTCOME_X = "uhCkkWDUtY29tZVggLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
const CONNECTION_XC = "uhCkkY29ublhDLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";

function mctx(derived?: MapCtx["derived"]): MapCtx {
  return { lang: LANG, hashToUrl: (h) => `${LANG}://${h}`, agentToDid, derived };
}

// Build a lastSnapshot-shaped map out of WireRecords, the way takeSnapshot
// fills it (derive edges from the connection set, then map each record).
function mkSnapshot(recs: { class: string; rec: any }[]): SignalCtx["snapshot"] {
  const conns = recs.filter((r) => r.class === "AcornConnection").map((r) => r.rec);
  const ctx = mctx(deriveRelations(conns));
  const m = new Map<string, { class: string; data: Record<string, unknown> }>();
  for (const { class: c, rec } of recs) {
    const addr = c === "AcornProfile" ? `profile/${rec.agentPubKey}` : rec.actionHash;
    m.set(addr, { class: c, data: toData(c, rec, ctx) });
  }
  return m;
}

const ctx = (snapshot: SignalCtx["snapshot"]): SignalCtx => ({ lang: LANG, snapshot });

const outcomeA = () => wireRecord(smallOutcomeEntry(), { actionHash: OUTCOME_A });
const outcomeB = () =>
  wireRecord(uncertainOutcomeEntry(), { actionHash: OUTCOME_B });
const connAB = () =>
  wireRecord(connectionEntry(), { actionHash: CONNECTION_AB });

test("Outcome create signal -> one changed AcornOutcome with mapped data", () => {
  // shape of the raw signal in test/fixtures/raw-signal.md
  const rec = outcomeA();
  const d = signalToDelta(
    {
      signalType: "Outcome",
      data: { entryType: "outcome", action: "create", data: rec },
    },
    ctx(new Map())
  );
  assert.ok(d);
  assert.equal(d.removed.length, 0);
  assert.equal(d.changed.length, 1);
  const e = d.changed[0];
  assert.equal(e.class, "AcornOutcome");
  assert.equal(e.address, OUTCOME_A);
  assert.equal(e.data.content, "Write the spec");
  assert.equal(e.data.creator, DID_A);
  assert.equal(e.data.scopeType, "Small");
  assert.equal(e.data.entryHash, ENTRY_HASH);
});

test("Outcome update signal -> changed AcornOutcome", () => {
  const rec = { ...outcomeA(), entry: { ...outcomeA().entry, content: "renamed" } };
  const d = signalToDelta(
    {
      signalType: "Outcome",
      data: { entryType: "outcome", action: "update", data: rec },
    },
    ctx(new Map())
  );
  assert.equal(d?.changed[0]?.data.content, "renamed");
});

test("Outcome delete signal -> removed: [hash]", () => {
  const d = signalToDelta(
    {
      signalType: "Outcome",
      data: { entryType: "outcome", action: "delete", data: OUTCOME_A },
    },
    ctx(new Map())
  );
  assert.ok(d);
  assert.equal(d.changed.length, 0);
  assert.deepEqual(d.removed, [OUTCOME_A]);
});

test("DeleteOutcomeFully -> outcome + 2 connections + 1 comment removed, parent changed", () => {
  // Snapshot: P --connAB--> C --connXC--> X, plus a comment on C.
  const outcomeX = () =>
    wireRecord(uncertainOutcomeEntry(), { actionHash: OUTCOME_X });
  const connXC = () =>
    wireRecord(
      {
        parentActionHash: OUTCOME_B,
        childActionHash: OUTCOME_X,
        siblingOrder: 0,
        randomizer: 1,
        isImported: false,
      },
      { actionHash: CONNECTION_XC }
    );
  const comment = () =>
    wireRecord(outcomeCommentEntry(), { actionHash: COMMENT_1 });
  const snapshot = mkSnapshot([
    { class: "AcornOutcome", rec: outcomeA() },
    { class: "AcornOutcome", rec: outcomeB() },
    { class: "AcornOutcome", rec: outcomeX() },
    { class: "AcornConnection", rec: connAB() },
    { class: "AcornConnection", rec: connXC() },
    { class: "AcornOutcomeComment", rec: comment() },
  ]);
  const d = signalToDelta(
    {
      signalType: "DeleteOutcomeFully",
      data: {
        entryType: "delete_outcome_fully",
        action: "delete",
        data: {
          outcomeActionHash: OUTCOME_B,
          deletedConnections: [CONNECTION_AB, CONNECTION_XC],
          deletedOutcomeMembers: [],
          deletedOutcomeVotes: [],
          deletedOutcomeComments: [COMMENT_1],
          deletedEntryPoints: [],
        },
      },
    },
    ctx(snapshot)
  );
  assert.ok(d);
  assert.deepEqual(
    [...d.removed].sort(),
    [OUTCOME_B, CONNECTION_AB, CONNECTION_XC, COMMENT_1].sort()
  );
  // P lost the child edge to C; X lost its parent edge
  const p = d.changed.find((e) => e.address === OUTCOME_A);
  assert.ok(p, "parent outcome P must be in changed");
  assert.equal(p.class, "AcornOutcome");
  assert.ok(
    !(Array.isArray(p.data.children) && p.data.children.includes(`${LANG}://${OUTCOME_B}`)),
    `P.children still lists C: ${JSON.stringify(p.data.children)}`
  );
  const x = d.changed.find((e) => e.address === OUTCOME_X);
  assert.ok(x, "child outcome X must be in changed");
  assert.ok(!("parent" in x.data), `X.parent still set: ${JSON.stringify(x.data)}`);
});

test("Member signal with snake-case entry_type -> changed AcornMember", () => {
  // MemberSignal serialises `entry_type` (no camelCase rename) and carries a
  // bare Member, not a WireRecord — the address comes from the snapshot.
  const snapshot = mkSnapshot([{ class: "AcornMember", rec: wireRecord(memberEntry(), { actionHash: MEMBER_1 }) }]);
  const d = signalToDelta(
    {
      signalType: "Member",
      data: { entry_type: "member", action: "create", data: { agentPubKey: AGENT_A } },
    },
    ctx(snapshot)
  );
  assert.ok(d);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].class, "AcornMember");
  assert.equal(d.changed[0].address, MEMBER_1);
  assert.equal(d.changed[0].data.agent, DID_A);
});

test("Member signal for an unknown agent -> null (left to the resync)", () => {
  const d = signalToDelta(
    {
      signalType: "Member",
      data: { entry_type: "member", action: "create", data: { agentPubKey: AGENT_B } },
    },
    ctx(new Map())
  );
  assert.equal(d, null);
});

test("RealtimeInfo -> null", () => {
  const d = signalToDelta(
    {
      signalType: "RealtimeInfo",
      data: {
        agentPubKey: AGENT_A,
        projectId: "x",
        outcomeBeingEdited: null,
        outcomeExpandedView: null,
      },
    },
    ctx(new Map())
  );
  assert.equal(d, null);
});

test("EditingOutcome and OutcomeVote -> null", () => {
  for (const signalType of ["EditingOutcome", "OutcomeVote"]) {
    const d = signalToDelta(
      { signalType, data: { entryType: "x", action: "create", data: {} } },
      ctx(new Map())
    );
    assert.equal(d, null, signalType);
  }
});

test("Connection create -> changed connection + both ends re-expanded", () => {
  const snapshot = mkSnapshot([
    { class: "AcornOutcome", rec: outcomeA() },
    { class: "AcornOutcome", rec: outcomeB() },
  ]);
  const d = signalToDelta(
    {
      signalType: "Connection",
      data: { entryType: "connection", action: "create", data: connAB() },
    },
    ctx(snapshot)
  );
  assert.ok(d);
  const conn = d.changed.find((e) => e.class === "AcornConnection");
  assert.equal(conn?.address, CONNECTION_AB);
  assert.equal(conn?.data.parent, `${LANG}://${OUTCOME_A}`);
  assert.equal(conn?.data.child, `${LANG}://${OUTCOME_B}`);
  const p = d.changed.find((e) => e.address === OUTCOME_A);
  assert.deepEqual(p?.data.children, [`${LANG}://${OUTCOME_B}`]);
  const c = d.changed.find((e) => e.address === OUTCOME_B);
  assert.equal(c?.data.parent, `${LANG}://${OUTCOME_A}`);
});

test("Connection delete -> removed + both ends re-expanded", () => {
  const snapshot = mkSnapshot([
    { class: "AcornOutcome", rec: outcomeA() },
    { class: "AcornOutcome", rec: outcomeB() },
    { class: "AcornConnection", rec: connAB() },
  ]);
  const d = signalToDelta(
    {
      signalType: "Connection",
      data: { entryType: "connection", action: "delete", data: CONNECTION_AB },
    },
    ctx(snapshot)
  );
  assert.ok(d);
  assert.deepEqual(d.removed, [CONNECTION_AB]);
  const p = d.changed.find((e) => e.address === OUTCOME_A);
  assert.ok(p && !("children" in p.data));
  const c = d.changed.find((e) => e.address === OUTCOME_B);
  assert.ok(c && !("parent" in c.data));
});

test("OutcomeWithConnection -> outcome + connection + parent in changed", () => {
  const snapshot = mkSnapshot([{ class: "AcornOutcome", rec: outcomeA() }]);
  const child = wireRecord(uncertainOutcomeEntry(), { actionHash: OUTCOME_B });
  const conn = connAB();
  const d = signalToDelta(
    {
      signalType: "OutcomeWithConnection",
      data: {
        entryType: "outcome_with_connection",
        action: "create",
        data: { outcome: child, maybeConnection: conn },
      },
    },
    ctx(snapshot)
  );
  assert.ok(d);
  const o = d.changed.find((e) => e.address === OUTCOME_B);
  assert.equal(o?.class, "AcornOutcome");
  assert.equal(o?.data.parent, `${LANG}://${OUTCOME_A}`);
  assert.ok(d.changed.some((e) => e.address === CONNECTION_AB));
  const p = d.changed.find((e) => e.address === OUTCOME_A);
  assert.deepEqual(p?.data.children, [`${LANG}://${OUTCOME_B}`]);
});

test("Agent (profiles zome) update -> changed profile at profile/<key>", () => {
  const rec = {
    actionHash: "uhCkkvHJvcm9maWxlLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh",
    entryHash: ENTRY_HASH,
    entry: { ...profileEntry(), firstName: "NewName" },
    createdAt: 1,
    updatedAt: 2,
  };
  const d = signalToDelta(
    {
      signalType: "Agent",
      data: { entryType: "agent", action: "update", data: rec },
    },
    ctx(new Map())
  );
  assert.ok(d);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].class, "AcornProfile");
  assert.equal(d.changed[0].address, `profile/${AGENT_A}`);
  assert.equal(d.changed[0].data.firstName, "NewName");
});

test("Tag create -> changed AcornTag", () => {
  const rec = wireRecord({ backgroundColor: "#112233", text: "urgent" }, { actionHash: "uhCkkdGFnMS4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh" });
  const d = signalToDelta(
    { signalType: "Tag", data: { entryType: "tag", action: "create", data: rec } },
    ctx(new Map())
  );
  assert.equal(d?.changed[0]?.class, "AcornTag");
  assert.equal(d?.changed[0]?.data.text, "urgent");
});

test("malformed payloads -> null, never throw", () => {
  for (const decoded of [null, undefined, {}, { signalType: 3 }, { signalType: "Outcome" }, { signalType: "Outcome", data: { action: "create" } }]) {
    assert.equal(signalToDelta(decoded, ctx(new Map())), null, JSON.stringify(decoded));
  }
});
