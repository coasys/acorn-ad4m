// Builds build/bundle.js: the language's ESM bundle with the Acorn hApp
// embedded base64 and the AD4M template-variable banner.
//
//   ACORN_DEBUG_CALL=1 node build.mjs   — adds the generic `call` interaction
//   node build.mjs                      — only `info`
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

const BANNER = '//!@ad4m-template-variable\nconst seed = "";';

await build({
  entryPoints: [join(HERE, "src", "index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["ad4m:host"],
  outfile: join(HERE, "build", "bundle.js"),
  banner: { js: BANNER },
  define: {
    ACORN_HAPP_B64: JSON.stringify(happ.toString("base64")),
    ACORN_DEBUG_CALL: debugCall ? "true" : "false",
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
  `build: bundle.js written (happ sha256 ${sha256.slice(0, 16)}…, ${happ.length} bytes, debug call ${debugCall ? "on" : "off"})`
);
