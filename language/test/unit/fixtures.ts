// Shared fixtures for the B3 unit tests — the same records mapping.test.ts
// uses, exported so the round-trip and merge tests build on one source.

export const LANG = "QmzLangTest";
export const SEED = "uid-rig-test-project";

// Agents (real keys, see agent.test.ts).
export const AGENT_A = "uhCAkDsZGYpTXiihwf8CcfsbpLcyzmP_jMWv28biNaAknxgUudQnS";
export const AGENT_B = "uhCAk4vA0NdZ55vQYDvbdNKf23Emrho0SHs8KlgxA8pVD4aG_aGbO";

// Record hashes (opaque strings — the mapping never decodes them).
export const OUTCOME_A = "uhCkkb3V0Y29tZUEuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
export const OUTCOME_B = "uhCkkb3V0Y29tZUIuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
export const CONNECTION_AB = "uhCkkY29ubkFCLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
export const TAG_T = "uhCkkdGFnVC4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
export const COMMENT_1 = "uhCkkY29tbWVudDEuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
export const ENTRY_POINT_1 = "uhCkkZXAxLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
export const OUTCOME_MEMBER_1 = "uhCkkb20xLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
export const PROJECT_META = "uhCkkbWV0YTEuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
export const MEMBER_1 = "uhCkkbWVtYmVyMS4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";
export const ENTRY_HASH = "uhCkkZW50cnkLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi5sb2Mh";

export function wireRecord(entry: unknown, extra: Partial<Record<string, unknown>> = {}) {
  return {
    actionHash: (extra.actionHash as string) ?? OUTCOME_A,
    entryHash: ENTRY_HASH,
    entry,
    createdAt: 1763370000123456,
    updatedAt: 1763370111456789,
  };
}

export function smallOutcomeEntry() {
  return {
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
  };
}

export function uncertainOutcomeEntry() {
  return {
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
  };
}

export function connectionEntry() {
  return {
    parentActionHash: OUTCOME_A,
    childActionHash: OUTCOME_B,
    siblingOrder: 0,
    randomizer: 1763370000999,
    isImported: false,
  };
}

export function entryPointEntry() {
  return {
    color: "#aabbcc",
    creatorAgentPubKey: AGENT_A,
    createdAt: 1763370001.25,
    outcomeActionHash: OUTCOME_A,
    isImported: false,
  };
}

export function outcomeCommentEntry() {
  return {
    outcomeActionHash: OUTCOME_A,
    content: "a comment",
    creatorAgentPubKey: AGENT_A,
    unixTimestamp: 1763370002.5,
    isImported: false,
  };
}

export function outcomeMemberEntry() {
  return {
    outcomeActionHash: OUTCOME_A,
    memberAgentPubKey: AGENT_B,
    creatorAgentPubKey: AGENT_A,
    unixTimestamp: 1763370003.5,
    isImported: false,
  };
}

export function tagEntry() {
  return { backgroundColor: "#112233", text: "urgent" };
}

export function projectMetaEntry() {
  return {
    creatorAgentPubKey: AGENT_A,
    createdAt: 1763370004.5,
    name: "Rig Project",
    image: "data:image/png;base64,xx",
    passphrase: "rig test project",
    isImported: false,
    layeringAlgorithm: "LongestPath",
    topPriorityOutcomes: [OUTCOME_A, OUTCOME_B],
    isMigrated: "0.7",
  };
}

export function memberEntry() {
  return { agentPubKey: AGENT_A };
}

export function profileEntry() {
  return {
    firstName: "Stock",
    lastName: "Rig",
    handle: "stockrig",
    status: "Online",
    avatarUrl: "",
    agentPubKey: AGENT_A,
    isImported: false,
  };
}
