import test from "node:test";
import assert from "node:assert/strict";
import { agentToDid } from "../../src/agent";
import { toData, addressOf, type MapCtx } from "../../src/mapping";

const LANG = "QmzLangTest";

// Agents (real keys, see agent.test.ts).
const AGENT_A = "uhCAkDsZGYpTXiihwf8CcfsbpLcyzmP_jMWv28biNaAknxgUudQnS";
const AGENT_B = "uhCAk4vA0NdZ55vQYDvbdNKf23Emrho0SHs8KlgxA8pVD4aG_aGbO";
const DID_A = agentToDid(AGENT_A);
const DID_B = agentToDid(AGENT_B);

// Record hashes (opaque strings — the mapping never decodes them).
const OUTCOME_A = "uhCkkb3V0Y29tZUEuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
const OUTCOME_B = "uhCkkb3V0Y29tZUIuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
const CONNECTION_AB = "uhCkkY29ubkFCLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
const TAG_T = "uhCkkdGFnVC4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
const COMMENT_1 = "uhCkkY29tbWVudDEuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
const ENTRY_POINT_1 = "uhCkkZXAxLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
const OUTCOME_MEMBER_1 = "uhCkkb20xLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
const PROJECT_META = "uhCkkbWV0YTEuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
const MEMBER_1 = "uhCkkbWVtYmVyMS4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
const ENTRY_HASH = "uhCkkZW50cnkLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";

function wireRecord(entry: unknown, extra: Partial<Record<string, unknown>> = {}) {
  return {
    actionHash: (extra.actionHash as string) ?? OUTCOME_A,
    entryHash: ENTRY_HASH,
    entry,
    createdAt: 1763370000123456,
    updatedAt: 1763370111456789,
  };
}

const ctx: MapCtx = {
  lang: LANG,
  hashToUrl: (h) => `${LANG}://${h}`,
  agentToDid,
  derived: {
    parents: new Map([[OUTCOME_B, OUTCOME_A]]),
    children: new Map([[OUTCOME_A, [OUTCOME_B]]]),
  },
};

function smallOutcome() {
  return wireRecord({
    content: "Write the spec",
    creatorAgentPubKey: AGENT_A,
    editorAgentPubKey: AGENT_B,
    timestampCreated: 1763370000.123,
    timestampUpdated: 1763370111.456,
    scope: {
      Small: {
        achievementStatus: "NotAchieved",
        targetDate: 1763500000.5,
        taskList: [
          { complete: false, task: "draft" },
          { complete: true, task: "review" },
        ],
      },
    },
    tags: [TAG_T],
    description: "the description",
    isImported: false,
    githubLink: "https://github.com/x/y",
  });
}

test("AcornOutcome (Small scope) maps every property", () => {
  const data = toData("AcornOutcome", smallOutcome(), ctx);
  assert.equal(data.content, "Write the spec");
  assert.equal(data.description, "the description");
  assert.equal(data.githubLink, "https://github.com/x/y");
  assert.equal(data.scopeType, "Small");
  assert.equal(data.achievementStatus, "NotAchieved");
  assert.equal(data.targetDate, 1763500000.5);
  assert.equal(
    data.taskList,
    JSON.stringify([
      { complete: false, task: "draft" },
      { complete: true, task: "review" },
    ])
  );
  // fields of the other scope variant are absent, not null
  assert.ok(!("smallsEstimate" in data));
  assert.ok(!("timeFrame" in data));
  assert.ok(!("inBreakdown" in data));

  assert.deepEqual(data.tags, [`${LANG}://${TAG_T}`]);
  assert.equal(data.creator, DID_A);
  assert.equal(data.editor, DID_B);
  assert.equal(data.timestampCreated, 1763370000.123);
  assert.equal(data.timestampUpdated, 1763370111.456);
  assert.equal(data.isImported, false);

  // derived from the connections in ctx
  assert.deepEqual(data.children, [`${LANG}://${OUTCOME_B}`]);
  assert.ok(!("parent" in data));

  // WireRecord metadata
  assert.equal(data.entryHash, ENTRY_HASH);
  assert.equal(data.recordCreatedAt, 1763370000123456);
  assert.equal(data.recordUpdatedAt, 1763370111456789);
});

test("AcornOutcome (Uncertain scope) maps every property", () => {
  const rec = wireRecord(
    {
      content: "Big thing",
      creatorAgentPubKey: AGENT_A,
      editorAgentPubKey: null,
      timestampCreated: 1763370000.0,
      timestampUpdated: null,
      scope: {
        Uncertain: {
          smallsEstimate: 5,
          timeFrame: { fromDate: 1763400000.0, toDate: 1763700000.0 },
          inBreakdown: true,
        },
      },
      tags: [],
      description: "",
      isImported: true,
      githubLink: "",
    },
    { actionHash: OUTCOME_B }
  );
  const data = toData("AcornOutcome", rec, ctx);
  assert.equal(data.scopeType, "Uncertain");
  assert.equal(data.smallsEstimate, 5);
  assert.equal(
    data.timeFrame,
    JSON.stringify({ fromDate: 1763400000.0, toDate: 1763700000.0 })
  );
  assert.equal(data.inBreakdown, true);
  assert.ok(!("achievementStatus" in data));
  assert.ok(!("targetDate" in data));
  assert.ok(!("taskList" in data));

  // absent optional fields stay absent
  assert.ok(!("editor" in data));
  assert.ok(!("timestampUpdated" in data));
  assert.deepEqual(data.tags, []);
  assert.equal(data.parent, `${LANG}://${OUTCOME_A}`);
  assert.ok(!("children" in data));
  assert.equal(data.isImported, true);
});

test("AcornOutcome with no connection has neither parent nor children keys", () => {
  const rec = wireRecord(smallOutcome().entry, { actionHash: TAG_T });
  const data = toData("AcornOutcome", rec, ctx);
  assert.ok(!("parent" in data));
  assert.ok(!("children" in data));
});

test("AcornConnection maps refs to full URLs", () => {
  const rec = wireRecord(
    {
      parentActionHash: OUTCOME_A,
      childActionHash: OUTCOME_B,
      siblingOrder: 0,
      randomizer: 1763370000999,
      isImported: false,
    },
    { actionHash: CONNECTION_AB }
  );
  const data = toData("AcornConnection", rec, ctx);
  assert.equal(data.parent, `${LANG}://${OUTCOME_A}`);
  assert.equal(data.child, `${LANG}://${OUTCOME_B}`);
  assert.equal(data.siblingOrder, 0);
  assert.equal(data.randomizer, 1763370000999);
  assert.equal(data.isImported, false);
  assert.equal(data.entryHash, ENTRY_HASH);
});

test("AcornEntryPoint maps fields", () => {
  const rec = wireRecord({
    color: "#aabbcc",
    creatorAgentPubKey: AGENT_A,
    createdAt: 1763370001.25,
    outcomeActionHash: OUTCOME_A,
    isImported: false,
  });
  const data = toData("AcornEntryPoint", rec, ctx);
  assert.equal(data.color, "#aabbcc");
  assert.equal(data.outcome, `${LANG}://${OUTCOME_A}`);
  assert.equal(data.creator, DID_A);
  assert.equal(data.createdAtTime, 1763370001.25);
  assert.equal(data.isImported, false);
});

test("AcornOutcomeComment maps fields", () => {
  const rec = wireRecord(
    {
      outcomeActionHash: OUTCOME_A,
      content: "a comment",
      creatorAgentPubKey: AGENT_A,
      unixTimestamp: 1763370002.5,
      isImported: false,
    },
    { actionHash: COMMENT_1 }
  );
  const data = toData("AcornOutcomeComment", rec, ctx);
  assert.equal(data.outcome, `${LANG}://${OUTCOME_A}`);
  assert.equal(data.content, "a comment");
  assert.equal(data.creator, DID_A);
  assert.equal(data.unixTimestamp, 1763370002.5);
  assert.equal(data.isImported, false);
});

test("AcornOutcomeMember maps fields", () => {
  const rec = wireRecord(
    {
      outcomeActionHash: OUTCOME_A,
      memberAgentPubKey: AGENT_B,
      creatorAgentPubKey: AGENT_A,
      unixTimestamp: 1763370003.5,
      isImported: false,
    },
    { actionHash: OUTCOME_MEMBER_1 }
  );
  const data = toData("AcornOutcomeMember", rec, ctx);
  assert.equal(data.outcome, `${LANG}://${OUTCOME_A}`);
  assert.equal(data.member, DID_B);
  assert.equal(data.creator, DID_A);
  assert.equal(data.unixTimestamp, 1763370003.5);
});

test("AcornTag maps fields", () => {
  const rec = wireRecord(
    { backgroundColor: "#112233", text: "urgent" },
    { actionHash: TAG_T }
  );
  const data = toData("AcornTag", rec, ctx);
  assert.equal(data.text, "urgent");
  assert.equal(data.backgroundColor, "#112233");
});

test("AcornProjectMeta maps fields and drops the passphrase", () => {
  const rec = wireRecord(
    {
      creatorAgentPubKey: AGENT_A,
      createdAt: 1763370004.5,
      name: "Rig Project",
      image: "data:image/png;base64,xx",
      passphrase: "rig test project",
      isImported: false,
      layeringAlgorithm: "LongestPath",
      topPriorityOutcomes: [OUTCOME_A, OUTCOME_B],
      isMigrated: "0.7",
    },
    { actionHash: PROJECT_META }
  );
  const data = toData("AcornProjectMeta", rec, ctx);
  assert.equal(data.name, "Rig Project");
  assert.equal(data.image, "data:image/png;base64,xx");
  assert.equal(data.layeringAlgorithm, "LongestPath");
  assert.deepEqual(data.topPriorityOutcomes, [
    `${LANG}://${OUTCOME_A}`,
    `${LANG}://${OUTCOME_B}`,
  ]);
  assert.equal(data.creator, DID_A);
  assert.equal(data.createdAtTime, 1763370004.5);
  assert.equal(data.isImported, false);
  assert.equal(data.isMigrated, "0.7");
  assert.ok(!("passphrase" in data), "data must not carry the passphrase");
  assert.ok(!Object.keys(data).some((k) => k.toLowerCase().includes("passphrase")));
});

test("AcornMember maps the agent key to a did", () => {
  const rec = wireRecord({ agentPubKey: AGENT_A }, { actionHash: MEMBER_1 });
  const data = toData("AcornMember", rec, ctx);
  assert.equal(data.agent, DID_A);
});

test("AcornProfile maps a bare Profile (no WireRecord)", () => {
  const profile = {
    firstName: "Stock",
    lastName: "Rig",
    handle: "stockrig",
    status: "Online",
    avatarUrl: "",
    agentPubKey: AGENT_A,
    isImported: false,
  };
  const data = toData("AcornProfile", profile, ctx);
  assert.equal(data.firstName, "Stock");
  assert.equal(data.lastName, "Rig");
  assert.equal(data.handle, "stockrig");
  assert.equal(data.status, "Online");
  assert.equal(data.avatarUrl, "");
  assert.equal(data.agent, DID_A);
  assert.equal(data.agentPubKey, AGENT_A);
  assert.equal(data.isImported, false);
  // a bare entry has no WireRecord fields
  assert.ok(!("entryHash" in data));
  assert.ok(!("recordCreatedAt" in data));
  assert.ok(!("recordUpdatedAt" in data));
});

test("addresses: actionHash except profile/<agent>", () => {
  assert.equal(addressOf("AcornOutcome", smallOutcome()), OUTCOME_A);
  const profile = { agentPubKey: AGENT_A };
  assert.equal(addressOf("AcornProfile", profile), `profile/${AGENT_A}`);
});
