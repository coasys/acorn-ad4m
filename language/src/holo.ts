// HoloHash base64 helpers. Holochain hashes cross the executor bridge as
// 39-byte Uint8Arrays; on the wire and in test output they appear as
// "u" + base64url (no padding), e.g. uhC0k… (DNA) / uhCAk… (agent).

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64DecodeCore(s: string, alpha: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const ch = clean[i + k];
      n = (n << 6) | (ch === undefined ? 0 : alpha.indexOf(ch));
    }
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out.subarray(0, o);
}

/** 39 hash bytes -> "u" + base64url (no padding), the display form of a HoloHash. */
export function bytesToB64(u8: Uint8Array): string {
  let out = "u";
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i];
    const b = u8[i + 1];
    const c = u8[i + 2];
    const n = (a << 16) | (((b as number) || 0) << 8) | ((c as number) || 0);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
    if (b !== undefined) out += B64URL[(n >> 6) & 63];
    if (c !== undefined) out += B64URL[n & 63];
  }
  return out;
}

/** "u" + base64url (or bare base64url) -> bytes. Inverse of bytesToB64. */
export function b64ToBytes(s: string): Uint8Array {
  const body = s.startsWith("u") ? s.slice(1) : s;
  return b64DecodeCore(body, B64URL);
}

/** Standard base64 (the embedded hApp blob) -> bytes. */
export function stdB64ToBytes(s: string): Uint8Array {
  return b64DecodeCore(s, B64STD);
}

// Zome-call argument/result marking. Binary fields travel between the
// language and the conductor as Uint8Array; JSON callers can't produce one,
// so params accept { __holob64: "uh…" } markers and results mark 39-byte
// values back as { __hash: "uh…" } for readability (step-0 convention).

export function deepDecode(v: any): any {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(deepDecode);
  if (typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1 && typeof v.__holob64 === "string")
      return b64ToBytes(v.__holob64);
    if (keys.length === 1 && typeof v.__hash === "string")
      return b64ToBytes(v.__hash);
    const o: Record<string, any> = {};
    for (const k of keys) o[k] = deepDecode(v[k]);
    return o;
  }
  return v;
}

export function deepEncode(v: any): any {
  if (v === null || v === undefined) return v;
  if (v instanceof Uint8Array) {
    if (v.length === 39) return { __hash: bytesToB64(v) };
    return { __bytes: Array.from(v) };
  }
  if (Array.isArray(v)) return v.map(deepEncode);
  if (typeof v === "object") {
    const o: Record<string, any> = {};
    for (const k of Object.keys(v)) o[k] = deepEncode(v[k]);
    return o;
  }
  return v;
}
