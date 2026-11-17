import test from "node:test";
import assert from "node:assert/strict";
import { bytesToB64, b64ToBytes } from "../../src/holo";

test("bytesToB64/b64ToBytes round-trips a 39-byte hash", () => {
  const x = new Uint8Array(39).map((_, i) => (i * 7 + 3) & 0xff);
  const s = bytesToB64(x);
  assert.equal(s.length, 53); // "u" + 52 chars
  assert.equal(s[0], "u");
  assert.deepEqual(b64ToBytes(s), x);
});

test("a known step-0 DNA hash decodes to 39 bytes with the DNA prefix", () => {
  // seeded clone DNA hash from NOTES-s0 (0.7.0 rebuild, uid-spike-test-project)
  const h = "uhC0kXmLckqDQnD24m-HfdIQ6hw5jcWJuUg45rkFg0aPpBZubdViY";
  const b = b64ToBytes(h);
  assert.equal(b.length, 39);
  assert.deepEqual([...b.slice(0, 3)], [0x84, 0x2d, 0x24]);
  assert.equal(bytesToB64(b), h);
});

test("a known step-0 agent key decodes to 39 bytes with the agent prefix", () => {
  const h = "uhCAkDsZGYpTXiihwf8CcfsbpLcyzmP_jMWv28biNaAknxgUudQnS";
  const b = b64ToBytes(h);
  assert.equal(b.length, 39);
  assert.deepEqual([...b.slice(0, 3)], [0x84, 0x20, 0x24]);
  assert.equal(bytesToB64(b), h);
});
