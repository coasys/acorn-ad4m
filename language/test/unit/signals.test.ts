// B4 signals -> mount deltas (spec/11-b4-signals.md), B6 verification:
// a signal is only an invalidation hint — the delta is built exclusively
// from records fetched through the zomes (injected `ctx.fetch`), never
// from the signal's own fields (Lal review P1). A claimed change that the
// fetch cannot confirm produces no delta; a claimed delete produces
// `removed` only when the fetch confirms the record is gone; a profile is
// emitted only as fetched, for the agent key it claims.
//
// The decoded envelope fixtures are written from the Rust signal types
// (happs/happ/zomes/projects/src/lib.rs:43-65, hdk_crud/src/signals.rs:80-86,
// member/entry.rs:8-13, profiles/src/lib.rs:285-307) and the one signal
// captured on the rig (test/fixtures/raw-signal.md).
import test from "node:test";
import assert from "node:assert/strict";
import { agentToDid } from "../../src/agent";
import { deriveRelations, toData, type MapCtx } from "../../src/mapping";
import {
  signalToDelta,
  type FetchKind,
  type SignalCtx,
} from "../../src/signals";
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

// A fetch that answers `table[kind]` for every poll — the verified side.
const fetchOf =
  (table: Partial<Record<FetchKind, any[]>>): SignalCtx["fetch"] =>
  async (kind) =>
    table[kind] ?? [];

const ctx = (
  snapshot: SignalCtx["snapshot"],
  fetch?: SignalCtx["fetch"]
): SignalCtx => ({
  lang: LANG,
  snapshot,
  fetch: fetch ?? fetchOf({}),
  confirmTries: 3,
  confirmDelayMs: 1,
});

const outcomeA = () => wireRecord(smallOutcomeEntry(), { actionHash: OUTCOME_A });
const outcomeB = () =>
  wireRecord(uncertainOutcomeEntry(), { actionHash: OUTCOME_B });
const connAB = () =>
  wireRecord(connectionEntry(), { actionHash: CONNECTION_AB });

test("Outcome create signal -> one changed AcornOutcome with mapped data", async () => {
  // shape of the raw signal in test/fixtures/raw-signal.md
  const rec = outcomeA();
  const d = await signalToDelta(
    {
      signalType: "Outcome",
      data: { entryType: "outcome", action: "create", data: rec },
    },
    ctx(new Map(), fetchOf({ outcomes: [rec] }))
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

test("Outcome create signal the fetch cannot confirm -> null", async () => {
  // the signal's own record is never a source: nothing fetched, nothing mounted
  const rec = outcomeA();
  const d = await signalToDelta(
    {
      signalType: "Outcome",
      data: { entryType: "outcome", action: "create", data: rec },
    },
    ctx(new Map(), fetchOf({ outcomes: [] }))
  );
  assert.equal(d, null);
});

test("Outcome update signal -> changed AcornOutcome from the fetch", async () => {
  const entry = outcomeA().entry as Record<string, unknown>;
  const fetched = { ...outcomeA(), entry: { ...entry, content: "renamed" } };
  const d = await signalToDelta(
    {
      signalType: "Outcome",
      data: { entryType: "outcome", action: "update", data: fetched },
    },
    ctx(new Map(), fetchOf({ outcomes: [fetched] }))
  );
  assert.equal(d?.changed[0]?.data.content, "renamed");
});

test("forged update signal emits the fetched record, not the claimed one", async () => {
  // the signal claims content "HACKED" with a far-future updatedAt; the
  // fetch keeps answering the real record — the delta must carry the
  // fetched truth, never the claim.
  const real = outcomeA();
  const forged = {
    ...outcomeA(),
    updatedAt: 9999999999999999,
    entry: { ...(outcomeA().entry as Record<string, unknown>), content: "HACKED" },
  };
  const d = await signalToDelta(
    {
      signalType: "Outcome",
      data: { entryType: "outcome", action: "update", data: forged },
    },
    ctx(new Map(), fetchOf({ outcomes: [real] }))
  );
  assert.ok(d, "the fetched record still produces a (re-asserting) delta");
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].address, OUTCOME_A);
  assert.equal(d.changed[0].data.content, "Write the spec");
});

test("forged update of a record that does not exist -> null", async () => {
  const d = await signalToDelta(
    {
      signalType: "Outcome",
      data: {
        entryType: "outcome",
        action: "update",
        data: wireRecord(
          { ...smallOutcomeEntry(), content: "ghost" },
          { actionHash: "uhCkkTm90aGVyZS4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh" }
        ),
      },
    },
    ctx(new Map(), fetchOf({ outcomes: [outcomeA()] }))
  );
  assert.equal(d, null);
});

test("Outcome delete signal -> removed: [hash] once the fetch confirms it gone", async () => {
  const d = await signalToDelta(
    {
      signalType: "Outcome",
      data: { entryType: "outcome", action: "delete", data: OUTCOME_A },
    },
    ctx(new Map(), fetchOf({ outcomes: [] }))
  );
  assert.ok(d);
  assert.equal(d.changed.length, 0);
  assert.deepEqual(d.removed, [OUTCOME_A]);
});

test("forged delete of a record that still fetches -> null, nothing removed", async () => {
  const snapshot = mkSnapshot([{ class: "AcornOutcome", rec: outcomeA() }]);
  const d = await signalToDelta(
    {
      signalType: "Outcome",
      data: { entryType: "outcome", action: "delete", data: OUTCOME_A },
    },
    ctx(snapshot, fetchOf({ outcomes: [outcomeA()] }))
  );
  assert.equal(d, null);
});

test("DeleteOutcomeFully -> outcome + 2 connections + 1 comment removed, parent changed", async () => {
  // Snapshot: P --connAB--> C --connXC--> X, plus a comment on C. The
  // delete took C, both connections and the comment; P and X fetch on.
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
  const d = await signalToDelta(
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
    ctx(
      snapshot,
      fetchOf({
        outcomes: [outcomeA(), outcomeX()],
        connections: [],
        comments: [],
        outcomeMembers: [],
        entryPoints: [],
      })
    )
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

test("DeleteOutcomeFully only removes what the fetch confirms gone", async () => {
  // the signal claims the connection and comment died with the outcome,
  // but both still fetch — only the outcome itself is confirmed.
  const comment = () =>
    wireRecord(outcomeCommentEntry(), { actionHash: COMMENT_1 });
  const d = await signalToDelta(
    {
      signalType: "DeleteOutcomeFully",
      data: {
        entryType: "delete_outcome_fully",
        action: "delete",
        data: {
          outcomeActionHash: OUTCOME_B,
          deletedConnections: [CONNECTION_AB],
          deletedOutcomeMembers: [],
          deletedOutcomeVotes: [],
          deletedOutcomeComments: [COMMENT_1],
          deletedEntryPoints: [],
        },
      },
    },
    ctx(
      new Map(),
      fetchOf({
        outcomes: [],
        connections: [connAB()],
        comments: [comment()],
        outcomeMembers: [],
        entryPoints: [],
      })
    )
  );
  assert.ok(d);
  assert.deepEqual(d.removed, [OUTCOME_B]);
});

test("Member signal with snake-case entry_type -> changed AcornMember", async () => {
  // MemberSignal serialises `entry_type` (no camelCase rename) and carries a
  // bare Member, not a WireRecord — the member's mounted address comes from
  // the fetched record's actionHash, not the signal.
  const rec = wireRecord(memberEntry(), { actionHash: MEMBER_1 });
  const d = await signalToDelta(
    {
      signalType: "Member",
      data: { entry_type: "member", action: "create", data: { agentPubKey: AGENT_A } },
    },
    ctx(new Map(), fetchOf({ members: [rec] }))
  );
  assert.ok(d);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].class, "AcornMember");
  assert.equal(d.changed[0].address, MEMBER_1);
  assert.equal(d.changed[0].data.agent, DID_A);
});

test("Member signal for an agent with no fetched member -> null", async () => {
  const d = await signalToDelta(
    {
      signalType: "Member",
      data: { entry_type: "member", action: "create", data: { agentPubKey: AGENT_B } },
    },
    ctx(new Map(), fetchOf({ members: [wireRecord(memberEntry(), { actionHash: MEMBER_1 })] }))
  );
  assert.equal(d, null);
});

test("RealtimeInfo -> null", async () => {
  const d = await signalToDelta(
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

test("EditingOutcome and OutcomeVote -> null", async () => {
  for (const signalType of ["EditingOutcome", "OutcomeVote"]) {
    const d = await signalToDelta(
      { signalType, data: { entryType: "x", action: "create", data: {} } },
      ctx(new Map())
    );
    assert.equal(d, null, signalType);
  }
});

test("Connection create -> changed connection + both ends re-expanded", async () => {
  const snapshot = mkSnapshot([
    { class: "AcornOutcome", rec: outcomeA() },
    { class: "AcornOutcome", rec: outcomeB() },
  ]);
  const conn = connAB();
  const d = await signalToDelta(
    {
      signalType: "Connection",
      data: { entryType: "connection", action: "create", data: conn },
    },
    ctx(
      snapshot,
      fetchOf({ connections: [conn], outcomes: [outcomeA(), outcomeB()] })
    )
  );
  assert.ok(d);
  const c = d.changed.find((e) => e.class === "AcornConnection");
  assert.equal(c?.address, CONNECTION_AB);
  assert.equal(c?.data.parent, `${LANG}://${OUTCOME_A}`);
  assert.equal(c?.data.child, `${LANG}://${OUTCOME_B}`);
  const p = d.changed.find((e) => e.address === OUTCOME_A);
  assert.deepEqual(p?.data.children, [`${LANG}://${OUTCOME_B}`]);
  const ch = d.changed.find((e) => e.address === OUTCOME_B);
  assert.equal(ch?.data.parent, `${LANG}://${OUTCOME_A}`);
});

test("Connection delete -> removed + both ends re-expanded", async () => {
  const snapshot = mkSnapshot([
    { class: "AcornOutcome", rec: outcomeA() },
    { class: "AcornOutcome", rec: outcomeB() },
    { class: "AcornConnection", rec: connAB() },
  ]);
  const d = await signalToDelta(
    {
      signalType: "Connection",
      data: { entryType: "connection", action: "delete", data: CONNECTION_AB },
    },
    ctx(
      snapshot,
      fetchOf({ connections: [], outcomes: [outcomeA(), outcomeB()] })
    )
  );
  assert.ok(d);
  assert.deepEqual(d.removed, [CONNECTION_AB]);
  const p = d.changed.find((e) => e.address === OUTCOME_A);
  assert.ok(p && !("children" in p.data));
  const c = d.changed.find((e) => e.address === OUTCOME_B);
  assert.ok(c && !("parent" in c.data));
});

test("forged connection delete while it still fetches -> null", async () => {
  const snapshot = mkSnapshot([
    { class: "AcornOutcome", rec: outcomeA() },
    { class: "AcornOutcome", rec: outcomeB() },
    { class: "AcornConnection", rec: connAB() },
  ]);
  const d = await signalToDelta(
    {
      signalType: "Connection",
      data: { entryType: "connection", action: "delete", data: CONNECTION_AB },
    },
    ctx(
      snapshot,
      fetchOf({ connections: [connAB()], outcomes: [outcomeA(), outcomeB()] })
    )
  );
  assert.equal(d, null);
});

test("OutcomeWithConnection -> outcome + connection + parent in changed", async () => {
  const snapshot = mkSnapshot([{ class: "AcornOutcome", rec: outcomeA() }]);
  const child = wireRecord(uncertainOutcomeEntry(), { actionHash: OUTCOME_B });
  const conn = connAB();
  const d = await signalToDelta(
    {
      signalType: "OutcomeWithConnection",
      data: {
        entryType: "outcome_with_connection",
        action: "create",
        data: { outcome: child, maybeConnection: conn },
      },
    },
    ctx(
      snapshot,
      fetchOf({ outcomes: [outcomeA(), child], connections: [conn] })
    )
  );
  assert.ok(d);
  const o = d.changed.find((e) => e.address === OUTCOME_B);
  assert.equal(o?.class, "AcornOutcome");
  assert.equal(o?.data.parent, `${LANG}://${OUTCOME_A}`);
  assert.ok(d.changed.some((e) => e.address === CONNECTION_AB));
  const p = d.changed.find((e) => e.address === OUTCOME_A);
  assert.deepEqual(p?.data.children, [`${LANG}://${OUTCOME_B}`]);
});

test("OutcomeWithConnection the fetch cannot confirm -> null", async () => {
  const child = wireRecord(uncertainOutcomeEntry(), { actionHash: OUTCOME_B });
  const d = await signalToDelta(
    {
      signalType: "OutcomeWithConnection",
      data: {
        entryType: "outcome_with_connection",
        action: "create",
        data: { outcome: child, maybeConnection: connAB() },
      },
    },
    ctx(new Map(), fetchOf({ outcomes: [], connections: [] }))
  );
  assert.equal(d, null);
});

test("Agent (profiles zome) update -> changed profile at profile/<key>", async () => {
  const fetched = { ...profileEntry(), firstName: "NewName" };
  const d = await signalToDelta(
    {
      signalType: "Agent",
      data: {
        entryType: "agent",
        action: "update",
        data: wireRecord(fetched, { actionHash: "uhCkkvHJvcm9maWxlLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh" }),
      },
    },
    ctx(new Map(), fetchOf({ profiles: [fetched] }))
  );
  assert.ok(d);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].class, "AcornProfile");
  assert.equal(d.changed[0].address, `profile/${AGENT_A}`);
  assert.equal(d.changed[0].data.firstName, "NewName");
});

test("forged profile signal emits the fetched profile, not the claimed one", async () => {
  // the claim says AGENT_A's name is "Forged"; the fetch says "Stock" —
  // the emitted profile must be the fetched one for the claimed key.
  const d = await signalToDelta(
    {
      signalType: "Agent",
      data: {
        entryType: "agent",
        action: "update",
        data: wireRecord(
          { ...profileEntry(), firstName: "Forged" },
          { actionHash: "uhCkkvHJvcm9maWxlLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh" }
        ),
      },
    },
    ctx(new Map(), fetchOf({ profiles: [profileEntry()] }))
  );
  assert.ok(d);
  assert.equal(d.changed[0].address, `profile/${AGENT_A}`);
  assert.equal(d.changed[0].data.firstName, "Stock");
});

test("profile signal for a key with no fetched profile -> null", async () => {
  const d = await signalToDelta(
    {
      signalType: "Agent",
      data: {
        entryType: "agent",
        action: "update",
        data: wireRecord(
          { ...profileEntry(), agentPubKey: AGENT_B },
          { actionHash: "uhCkkvHJvcm9maWxlLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh" }
        ),
      },
    },
    ctx(new Map(), fetchOf({ profiles: [profileEntry()] }))
  );
  assert.equal(d, null);
});

test("Tag create -> changed AcornTag", async () => {
  const rec = wireRecord(
    { backgroundColor: "#112233", text: "urgent" },
    { actionHash: "uhCkkdGFnMS4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh" }
  );
  const d = await signalToDelta(
    { signalType: "Tag", data: { entryType: "tag", action: "create", data: rec } },
    ctx(new Map(), fetchOf({ tags: [rec] }))
  );
  assert.equal(d?.changed[0]?.class, "AcornTag");
  assert.equal(d?.changed[0]?.data.text, "urgent");
});

test("no fetch on the context -> null (a signal that cannot be verified)", async () => {
  const d = await signalToDelta(
    {
      signalType: "Outcome",
      data: { entryType: "outcome", action: "create", data: outcomeA() },
    },
    { lang: LANG, snapshot: new Map() } as unknown as SignalCtx
  );
  assert.equal(d, null);
});

test("malformed payloads -> null, never throw", async () => {
  for (const decoded of [null, undefined, {}, { signalType: 3 }, { signalType: "Outcome" }, { signalType: "Outcome", data: { action: "create" } }]) {
    assert.equal(await signalToDelta(decoded, ctx(new Map())), null, JSON.stringify(decoded));
  }
});
