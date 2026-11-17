# acorn-ad4m

Acorn projects as an AD4M language (spike, step B1).

## Layout

- `language/` — the AD4M language. `node build.mjs` bundles `src/` into
  `build/bundle.js` with the Acorn hApp embedded and the
  `//!@ad4m-template-variable` seed banner. `ACORN_DEBUG_CALL=1` adds a
  generic `call` zome-call interaction for the rig tests.
- `language/vendor/acorn.happ` — the step-0 0.7.0 rebuild of Acorn's
  projects hApp (see `vendor/HAPP.md`: NOT the release DNA).
- `rig/` — two-node test rig: local kitsune2 bootstrap + relay, a stock
  Holochain 0.7.0 conductor holding an Acorn clone cell for `$SEED`, and
  an `ad4m-executor` built from the ad4m A-branch stack.

## Use

```bash
cd language && pnpm install && node build.mjs && node --import tsx --test test/unit/*.test.ts
cd rig && pnpm install

# build the executor once, from the ad4m checkout (A6 branch or later):
#   cargo build --release -p ad4m --bin ad4m-executor
AD4M_EXECUTOR=<path>/ad4m-executor rig/start.sh   # writes rig/.run/env

cd language && ACORN_DEBUG_CALL=1 node build.mjs
node --test rig/test/b1.test.mjs                  # add --test-reporter=tap for `# pass` lines
rig/stop.sh
```

The seed for `language.applyTemplateLocal` is the Acorn project uid
(`'uid-' + passphrase.split(' ').join('-')`). The templated language address
is deterministic: same passphrase, same address on every machine.
