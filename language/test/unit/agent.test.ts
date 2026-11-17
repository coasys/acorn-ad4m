import test from "node:test";
import assert from "node:assert/strict";
import { agentToDid, didToAgent } from "../../src/agent";

// Real AgentPubKeys: the first two are step 0's (NOTES-s0 Step 6), the third
// is a stock-conductor key from a B1 rig run. The expected did:key strings
// were computed independently (ed25519 multicodec 0xed01 + the 32 key bytes,
// base58btc).
const KEYS: [string, string][] = [
  [
    "uhCAkDsZGYpTXiihwf8CcfsbpLcyzmP_jMWv28biNaAknxgUudQnS",
    "did:key:z6MkfSw7Fd7NbD1NUUKuLRfbg1g3tsWZfJo8DQUGrAgBpsT2",
  ],
  [
    "uhCAk4vA0NdZ55vQYDvbdNKf23Emrho0SHs8KlgxA8pVD4aG_aGbO",
    "did:key:z6Mkuj8d5Du1Zb5cmKhrvpSUsq1cjFTBPHprjyskcw3XStBi",
  ],
  [
    "uhCAkMRlVEMTqdtRGNqO1cPVdMHYAuqkdhdIO4sKyW8lJKaG6Tjtp",
    "did:key:z6MkhkvRhaff3PqDEs39SEf2zjDAMNoHdUhd7i5a6sVWDmrg",
  ],
];

test("agentToDid produces the ed25519 did:key of the key's 32 bytes", () => {
  for (const [b64, did] of KEYS) {
    assert.equal(agentToDid(b64), did);
  }
});

test("didToAgent(agentToDid(k)) === k for real agent keys", () => {
  for (const [b64] of KEYS) {
    assert.equal(didToAgent(agentToDid(b64)), b64);
  }
});

test("didToAgent reads back a did:key produced elsewhere", () => {
  for (const [b64, did] of KEYS) {
    assert.equal(didToAgent(did), b64);
  }
});
