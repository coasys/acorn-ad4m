// Shared rig env handling: rig/.run/env is KEY=value lines written by
// start.sh; drivers and tests read it through here (process.env wins).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const RIG_DIR = join(dirname(fileURLToPath(import.meta.url)));
export const REPO_DIR = join(RIG_DIR, "..");
export const RUN_DIR = join(RIG_DIR, ".run");
export const ENV_PATH = join(RUN_DIR, "env");

// .run/env is written at the END of start.sh, so drivers start.sh itself
// invokes (stock.mjs setup, ad4m.mjs generate) must work without it: their
// values then come from process.env, which start.sh exports.
export function rigEnv() {
  const env = {};
  try {
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {
    /* no env file yet — fall through to process.env */
  }
  for (const k of [
    "BOOT_PORT",
    "HC_ADMIN",
    "AD4M_PORT",
    "SEED",
    "STOCK_DNA",
    "STOCK_AGENT",
    "STOCK_APP_PORT",
    "AD4M_DATA",
    "AD4M_AGENT_DID",
  ]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}
