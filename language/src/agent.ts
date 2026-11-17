// AgentPubKeyB64 <-> did:key.
//
// A Holochain AgentPubKey is 39 bytes: 3-byte prefix (0x84 0x20 0x24, the
// "uhCAk" in the b64), the 32-byte ed25519 key, and a 4-byte DHT location
// checksum (XOR-folded blake2b-128 of the key, see holo_hash's
// holo_dht_location_bytes). An Acorn agent in the mounted graph is the
// did:key of those 32 bytes: multicodec ed25519-pub (0xed 0x01) + key,
// base58btc with the 'z' marker (design §5.3). Both directions are pure.

import { blake2b } from "blakejs";
import { b64ToBytes, bytesToB64 } from "./holo";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const AGENT_PREFIX = [0x84, 0x20, 0x24];
const ED25519_MULTICODEC = [0xed, 0x01];

export function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const n = (digits[i] << 8) + carry;
      digits[i] = n % 58;
      carry = (n / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const b of bytes) {
    if (b === 0) out += "1";
    else break;
  }
  return out + digits.reverse().map((d) => B58[d]).join("");
}

export function base58Decode(s: string): Uint8Array {
  const bytes = [0];
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`bad base58 character ${JSON.stringify(ch)}`);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      const n = bytes[i] * 58 + carry;
      bytes[i] = n & 0xff;
      carry = n >> 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  for (const ch of s) {
    if (ch === "1") zeros++;
    else break;
  }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

/** AgentPubKeyB64 ("u" + base64url of 39 bytes) -> "did:key:z6Mk…" */
export function agentToDid(b64: string): string {
  const raw = b64ToBytes(b64);
  if (raw.length !== 39) {
    throw new Error(`agentToDid: expected a 39-byte agent key, got ${raw.length}`);
  }
  const key = raw.slice(3, 35);
  return "did:key:z" + base58Encode(new Uint8Array([...ED25519_MULTICODEC, ...key]));
}

/** "did:key:z6Mk…" -> AgentPubKeyB64; rebuilds the 4-byte DHT location. */
export function didToAgent(did: string): string {
  if (!did.startsWith("did:key:z")) {
    throw new Error(`didToAgent: not a did:key ${did}`);
  }
  const decoded = base58Decode(did.slice("did:key:z".length));
  if (
    decoded.length !== 34 ||
    decoded[0] !== ED25519_MULTICODEC[0] ||
    decoded[1] !== ED25519_MULTICODEC[1]
  ) {
    throw new Error(`didToAgent: not an ed25519 did:key ${did}`);
  }
  const key = decoded.slice(2);

  // DHT location: first 4 bytes of blake2b-128(key), XOR-folded in 4-byte
  // strides — holo_hash::encode::holo_dht_location_bytes.
  const h = blake2b(key, undefined, 16);
  const loc = new Uint8Array([h[0], h[1], h[2], h[3]]);
  for (let i = 4; i < 16; i += 4) {
    loc[0] ^= h[i];
    loc[1] ^= h[i + 1];
    loc[2] ^= h[i + 2];
    loc[3] ^= h[i + 3];
  }

  return bytesToB64(new Uint8Array([...AGENT_PREFIX, ...key, ...loc]));
}
