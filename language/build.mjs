// Builds build/bundle.js: the language's ESM bundle with the Acorn hApp
// embedded base64 and the AD4M template-variable banner.
//
//   ACORN_DEBUG_CALL=1 node build.mjs   — adds the generic `call` interaction
//   node build.mjs                      — only `info`
//   ACORN_TEST_BUILD=1 node build.mjs   — adds the `mountResync` switch
//   ACORN_TEST_BUILD=1 ACORN_MOUNT_RESYNC=off node build.mjs
//                                        — periodic resync starts off
//   (a production build ignores ACORN_MOUNT_RESYNC: the resync is the only
//    path that removes records, so it is always on there)
//
// The banner's two lines are what `language.applyTemplateLocal` rewrites:
// the file MUST start with them, and must never contain `var happ = `
// (the executor's templating would rewrite the bundled DNA's properties,
// giving a different DNA hash — design §5.1).
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const happ = readFileSync(join(HERE, "vendor", "acorn.happ"));
const sha256 = createHash("sha256").update(happ).digest("hex");
const debugCall = !!process.env.ACORN_DEBUG_CALL;
const testBuild = !!process.env.ACORN_TEST_BUILD;
// ACORN_MOUNT_RESYNC=off (test builds only): the periodic full resync
// starts switched off (src/index.ts `periodicResync`).
const resyncEnv = (process.env.ACORN_MOUNT_RESYNC ?? "on").toLowerCase();
if (!["on", "off", "1", "0", "true", "false"].includes(resyncEnv)) {
  console.error(`build: ACORN_MOUNT_RESYNC must be on|off, got ${resyncEnv}`);
  process.exit(1);
}
let mountResync = ["on", "1", "true"].includes(resyncEnv);
if (!mountResync && !testBuild) {
  console.warn("build: ACORN_MOUNT_RESYNC=off ignored — production build (set ACORN_TEST_BUILD=1)");
  mountResync = true;
}

const BANNER = '//!@ad4m-template-variable\nconst seed = "";';

await build({
  entryPoints: [join(HERE, "src", "index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  // neutral picks no mainFields by default; @msgpack/msgpack ships its ESM
  // build under "module" — prefer it so the bundle stays ESM for Deno.
  mainFields: ["module", "main"],
  target: "es2022",
  external: ["ad4m:host"],
  outfile: join(HERE, "build", "bundle.js"),
  banner: { js: BANNER },
  define: {
    ACORN_HAPP_B64: JSON.stringify(happ.toString("base64")),
    ACORN_DEBUG_CALL: debugCall ? "true" : "false",
    ACORN_MOUNT_RESYNC: mountResync ? "true" : "false",
    ACORN_TEST_BUILD: testBuild ? "true" : "false",
  },
});

const out = readFileSync(join(HERE, "build", "bundle.js"), "utf8");
const [line1, line2] = out.split("\n");
if (line1 !== "//!@ad4m-template-variable" || line2 !== 'const seed = "";') {
  console.error(
    `build: bundle does not start with the template banner:\n  ${line1}\n  ${line2}`
  );
  process.exit(1);
}
if (out.includes("var happ = ")) {
  console.error(
    'build: bundle contains "var happ = " — the executor templating would rewrite the DNA. Refusing.'
  );
  process.exit(1);
}

console.log(
  `build: bundle.js written (happ sha256 ${sha256.slice(0, 16)}…, ${happ.length} bytes, debug call ${debugCall ? "on" : "off"}, mount resync ${mountResync ? "on" : "off"}, test build ${testBuild ? "on" : "off"})`
);
