# acorn-ad4m

Acorn projects as an AD4M language: the Acorn `projects` DNA runs inside
AD4M's Holochain conductor, and the forked Acorn UI talks to it through a
language and an `AppClient` shim instead of a conductor app port. One
command starts a local bootstrap, an executor, the language and the UI —
a second person can demo an Acorn project syncing to a stock Acorn peer
on the same bootstrap.

## Prerequisites

- **Node** (24.x works), **pnpm**, **yarn 1.x**, **python3** (serves the
  built UI; also used by the rig).
- **ad4m-executor binary** built from the ad4m **A-step stack**
  (`acorn/a7-polymorphic-write` or later — the `language.applyTemplateLocal`
  and mount APIs the language needs; plain `dev` does not have them):
  `cargo build --release -p ad4m --bin ad4m-executor`.
- **The forked UI** checked out next to this repo (or set `ACORN_UI`):
  `acorn-ad4m-ui`, branch `ad4m/c3-live-updates`, `yarn install` once
  (run.sh runs it when `node_modules` is missing).
- **Holochain tools from step 0** for the local bootstrap:
  `kitsune2-bootstrap-srv` (bootstrap + relay in one). Put it on `PATH`,
  set `KITSUNE2_BOOTSTRAP_SRV`, or leave the step-0 tools dir in place —
  run.sh falls back to `/home/data/code/acorn-spike/tools/bin`.

## Run

```bash
AD4M_EXECUTOR=<path>/ad4m-executor ./run.sh
```

Starts the local bootstrap (default `:45300`), the executor (`:45400`,
data in `./.run/demo`, kept between runs), generates or unlocks the
agent, builds `language/`, publishes the base language, builds and
serves the UI on `:8080`, and prints the URL:

```
http://localhost:8080/?ad4m=ws://127.0.0.1:45400/api/v1/ws
```

`Ctrl-C` stops everything it started. `./run.sh --check` validates
inputs and ports and prints the plan without starting anything;
`./run.sh --fresh` wipes the data dir (new agent, empty state).
Env knobs: `ACORN_UI`, `AD4M_PORT`, `WEB_PORT`, `BOOT_PORT`, `DATA_DIR`,
`AGENT_PASS` (default `demo-passphrase` — keep it stable between runs or
the unlock fails). Logs land in `./.run/*.log`.

## Joining a project

On the dashboard pick **join an existing one** and paste the project
secret (the five words, e.g. `alpha bravo charlie delta echo`; the
project uid is `'uid-' + passphrase.split(' ').join('-')`). Any stock
Acorn peer on the same bootstrap+relay and the same DNA sees the same
project. Creating a project in the fork works too — share its
passphrase with the stock side.

## Pointing at real Acorn servers

The local bootstrap is a rig convenience: an AD4M executor and a stock
Acorn only meet on the DHT when they share bootstrap **and** relay
servers. To run the whole executor conductor on Acorn's real servers
(design §5.4 way 1):

```bash
HC_BOOTSTRAP_URL=https://bootstrap.acorn.example \
HC_RELAY_URL=https://relay.acorn.example \
AD4M_EXECUTOR=<path>/ad4m-executor ./run.sh
```

(set **both**, or neither for the local bootstrap.) Every language on
that executor then uses those servers — fine on a dedicated demo
machine.

## Known limits

- **Separate agent key.** The executor signs Holochain actions with its
  own lair key, not a Moss/Acorn key. A stock Acorn run by the same
  person shows them as a second member; the fork's member record carries
  the AD4M DID as `sameAs`.
- **No inbound presence.** Stock users' live cursors/selections
  (RealtimeInfo) are not delivered to the fork; everything else —
  outcomes, connections, tags, comments, members, profiles, project
  meta — syncs both ways.
- **0.7.0 DNA ≠ the real Acorn network until H1.** The bundled
  `language/vendor/acorn.happ` is a **rebuild of Acorn's happ against
  hdk 0.7.0** (AD4M's conductor is 0.7.0; the release DNA is hdk 0.7.1
  and its cells cannot init there — see `language/vendor/HAPP.md`). The
  DNA hash therefore differs from real Acorn users': this demo syncs
  with the rig's stock-0.7.0 conductor, not with the released Acorn
  app, until step H1 rebases the AD4M Holochain fork to 0.7.1.
- Writes from the stock side reach AD4M through signals + the mount's
  resync loop (live, ~1 s); AD4M→stock lands fast. Stock→AD4M *cold*
  reads ride full-arc gossip (can take minutes on a fresh join — the
  UI's own retries cover it).

## Layout

- `run.sh`, `test/run-script.test.sh` — the demo entry point and its
  `--check` test (`bash test/run-script.test.sh`).
- `language/` — the AD4M language. `node build.mjs` bundles `src/` into
  `build/bundle.js` with the Acorn hApp embedded and the
  `//!@ad4m-template-variable` seed banner. `ACORN_DEBUG_CALL=1` adds a
  generic `call` zome-call interaction for the rig tests.
- `language/vendor/acorn.happ` — the step-0 0.7.0 rebuild of Acorn's
  projects hApp (see `vendor/HAPP.md`: NOT the release DNA).
- `rig/` — two-node test rig: local kitsune2 bootstrap + relay, a stock
  Holochain 0.7.0 conductor holding an Acorn clone cell for `$SEED`, and
  an `ad4m-executor`. `rig/start.sh` brings it up on `rig/.run` (fresh
  each run); `node --test rig/test/b*.test.mjs` are the step tests.

## Rig use (unchanged)

```bash
cd language && pnpm install && node build.mjs && node --import tsx --test test/unit/*.test.ts
cd rig && pnpm install

AD4M_EXECUTOR=<path>/ad4m-executor rig/start.sh   # writes rig/.run/env

cd language && ACORN_DEBUG_CALL=1 node build.mjs
node --test rig/test/b1.test.mjs                  # add --test-reporter=tap for `# pass` lines
rig/stop.sh
```
