import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LANG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("bundle starts with the template banner and ships no `var happ =`", () => {
  execFileSync("node", ["build.mjs"], { cwd: LANG, stdio: "pipe" });
  const src = readFileSync(join(LANG, "build", "bundle.js"), "utf8");
  const lines = src.split("\n");
  assert.equal(lines[0], "//!@ad4m-template-variable");
  assert.equal(lines[1], 'const seed = "";');
  assert.ok(
    !src.includes("var happ = "),
    'bundle must not contain the text "var happ = "'
  );
});
