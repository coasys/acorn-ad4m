import test from "node:test";
import assert from "node:assert/strict";
import { agentToDid } from "../../src/agent";
import { toData, type MapCtx } from "../../src/mapping";
import {
  AGENT_A,
  AGENT_B,
  LANG,
  MEMBER_1,
  MEMBER_2,
  wireRecord,
} from "./fixtures";

// B5: the own member record carries `sameAs: <the AD4M DID>` — the
// Correction-15 form of the same_as claim (a did:key source cannot own
// links, so the own AcornMember carries it as a property). Snapshot mapping
// with two members whose own key is the second: only the second has
// `sameAs`, equal to the AD4M DID the host reports. Removing the own-key
// check in mapping.ts (giving every member `sameAs`) turns this red.
const AD4M_DID = "did:key:z6MkAd4mIdentityUnderTest";

const ctx: MapCtx = {
  lang: LANG,
  hashToUrl: (h) => `${LANG}://${h}`,
  agentToDid,
  ownAgent: AGENT_B,
  ad4mDid: AD4M_DID,
};

const memberRecord = (agentPubKey: string, actionHash: string) =>
  wireRecord({ agentPubKey }, { actionHash });

test("snapshot mapping: only the own member gets sameAs = ad4mDid", () => {
  // same shape takeSnapshot produces: two AcornMember records, own key B
  const memberA = toData("AcornMember", memberRecord(AGENT_A, MEMBER_1), ctx);
  const memberB = toData("AcornMember", memberRecord(AGENT_B, MEMBER_2), ctx);

  assert.equal(memberA.agent, agentToDid(AGENT_A));
  assert.ok(
    !("sameAs" in memberA),
    `other member must not get sameAs: ${JSON.stringify(memberA)}`
  );

  assert.equal(memberB.agent, agentToDid(AGENT_B));
  assert.equal(memberB.sameAs, AD4M_DID);
});

test("snapshot mapping: no own key -> no member gets sameAs", () => {
  const anon: MapCtx = { ...ctx, ownAgent: undefined };
  const memberB = toData("AcornMember", memberRecord(AGENT_B, MEMBER_2), anon);
  assert.ok(!("sameAs" in memberB));
});
