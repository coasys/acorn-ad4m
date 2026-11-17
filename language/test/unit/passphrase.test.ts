// The project seed "uid-a-b-c-d-e" becomes the Acorn passphrase "a b c d e" —
// the inverse of web/src/secrets.ts uidToPassphrase. ProjectMeta.passphrase is
// filled from this on create/update, never from interaction params.
import test from "node:test";
import assert from "node:assert/strict";
import { seedToPassphrase } from "../../src/mapping";

test("seedToPassphrase drops uid- and turns dashes into spaces", () => {
  assert.equal(seedToPassphrase("uid-a-b-c-d-e"), "a b c d e");
  assert.equal(seedToPassphrase("uid-rig-test-project"), "rig test project");
});
