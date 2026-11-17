# Raw Acorn signal capture (B4, design R11)

Captured on the step-B rig, 2026-11-17. Two views of the same
`create_outcome` signal sent by the stock conductor to all members.

## What `handleHolochainSignal` receives

The executor's `holochain_signal_receiver` rmpv-decodes the `ExternIO`
envelope once and hands the language `{ cell_id, zome_name, payload }`
(`rust-executor/src/lib.rs:116-168`). `payload` is **one msgpack byte blob**
(a `Uint8Array` after `convertBinaryMarkers`), not a decoded object — the
language must msgpack-decode it, exactly like the Acorn UI does
(`web/src/signalsHandlers.ts:136`).

Logged line (`rig/.run/executor.log`, via `ACORN_RAW_SIGNAL`):

```json
{"keys":["cell_id","zome_name","payload"],"payloadType":"Uint8Array(522)",
 "payloadHead":[130,170,115,105,103,110,97,108,84,121,112,101,167,79,117,116,99,111,109,101,164,100,97,116,97,131,169,101,110,116,114,121,84,121,112,101,167,111,117,116,99,111,109,101,166,97,99,116,105,111,110,166,99,114,101,97,116,101,164,100,97,116,97,133,170,97,99,116,105,111,110,72,97,115,104,217,53,117,104,67,107,107,...]}
```

Decoded by hand: `0x82` map(2) → `"signalType": "Outcome", "data": {...}`;
`0x83` map(3) → `{entryType, action, data}`; `0x85` map(5) → the WireRecord
`{actionHash, entryHash, entry, createdAt, updatedAt}`; `0xd9 0x35` str(53)
→ HoloHashB64 strings. No binary fields anywhere: every hash crosses as a
base64url string, so the second decode needs no `__binary` handling.

`cell_id` is `[[39 bytes],[39 bytes]]` (plain number arrays, not Uint8Array).

## Decoded payload of the same signal (stock-side `app.on("signal")`)

```json
{
  "signalType": "Outcome",
  "data": {
    "entryType": "outcome",
    "action": "create",
    "data": {
      "actionHash": "uhCkkMnUXaL4w21FR-hFFz5dfS5Pk24g46latCKxvTFBttlUy0alI",
      "entryHash": "uhCEk12JXFNQhQcBvCdCnPCAqnRdRN0VtzCNvEggMxYNhxCMP2F2G",
      "entry": {
        "content": "b4 fixture outcome 1794896416344",
        "creatorAgentPubKey": "uhCAk3Gmbd9ROZfoCdz-I8yiWO-pXVqqvaL5snl_cFJ8pZNnq5X32",
        "editorAgentPubKey": null,
        "timestampCreated": 1794896416344,
        "timestampUpdated": null,
        "scope": {
          "Small": { "achievementStatus": "NotAchieved", "targetDate": null, "taskList": [] }
        },
        "tags": [],
        "description": "",
        "isImported": false,
        "githubLink": ""
      },
      "createdAt": 1794896416354226,
      "updatedAt": 1794896416354226
    }
  }
}
```

## Conclusion for `signals.ts`

- One `@msgpack/msgpack` `decode(signal.payload)` yields the envelope
  `{ signalType, data }` (adjacently tagged `SignalType`).
- `data` is `{ entryType, action, data }` (`ActionSignal`, camelCase);
  `MemberSignal` writes `entry_type` (snake_case) and `data` is a bare
  `Member`, not a WireRecord.
- `decode` also returns Uint8Array for embedded binary; Acorn signals hold
  none (hashes are strings), so no post-processing is needed.
