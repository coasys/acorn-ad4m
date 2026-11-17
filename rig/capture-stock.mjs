// Second capture path: the stock conductor's own app ws receives the same
// emit_signal — dump the full signal, raw and msgpack-decoded, for
// language/test/fixtures/raw-signal.md.
import { createRequire } from "node:module";
import { join } from "node:path";
import { REPO_DIR } from "./envfile.mjs";
const { decode } = createRequire(join(REPO_DIR, "language", "package.json"))(
  "@msgpack/msgpack"
);
import * as stock from "./stock.mjs";

const S = await stock.connect();
const got = [];
S.app.on("signal", (s) => {
  const p = s.payload;
  const bytes = p instanceof Uint8Array ? p : new Uint8Array(p?.data ?? p ?? []);
  got.push({
    keys: Object.keys(s),
    zome_name: s.zome_name,
    payloadType: p?.constructor?.name,
    payloadLen: bytes.length,
    decoded: decode(bytes),
  });
});

const rec = await stock.createOutcome(S, `b4 stock-side capture ${Date.now()}`);
await new Promise((r) => setTimeout(r, 3000));
console.log(JSON.stringify(got, null, 2).slice(0, 6000));
await stock.closeStock(S);
