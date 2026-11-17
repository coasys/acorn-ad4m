#!/usr/bin/env bash
# run.sh — one command: local bootstrap -> ad4m-executor -> Acorn language ->
# the forked Acorn UI. Ctrl-C stops everything it started.
#
#   AD4M_EXECUTOR=<path>/ad4m-executor ./run.sh
#
# Flags:
#   --check   validate inputs and ports, print the plan, start nothing
#   --fresh   wipe DATA_DIR first (new agent, empty state)
#
# Env (all optional except AD4M_EXECUTOR):
#   AD4M_EXECUTOR   path to the ad4m-executor binary (required)
#   ACORN_UI        acorn-ad4m-ui checkout   (default ~/code/acorn-ad4m-ui)
#   AD4M_PORT       executor api port        (default 45400)
#   WEB_PORT        UI port                  (default 8080)
#   BOOT_PORT       local bootstrap port     (default 45300)
#   DATA_DIR        executor data dir        (default ./.run/demo)
#   AGENT_PASS      agent passphrase         (default demo-passphrase)
#   KITSUNE2_BOOTSTRAP_SRV  bootstrap binary (default: PATH, then the
#                   step-0 tools dir /home/data/code/acorn-spike/tools/bin)
#   HC_BOOTSTRAP_URL / HC_RELAY_URL — set BOTH to use real Acorn servers
#                   instead of the local bootstrap (design §5.4 way 1).
set -u
cd "$(dirname "$0")"
ROOT=$PWD
RUN_DIR="$ROOT/.run"

CHECK_ONLY=0
FRESH=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --fresh) FRESH=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "run.sh: unknown flag $arg (try --check, --fresh)" >&2; exit 2 ;;
  esac
done

ACORN_UI=${ACORN_UI:-$HOME/code/acorn-ad4m-ui}
AD4M_PORT=${AD4M_PORT:-45400}
WEB_PORT=${WEB_PORT:-8080}
BOOT_PORT=${BOOT_PORT:-45300}
DATA_DIR=${DATA_DIR:-$RUN_DIR/demo}
AGENT_PASS=${AGENT_PASS:-demo-passphrase}

LOCAL_BOOTSTRAP=1
if [ -n "${HC_BOOTSTRAP_URL:-}" ] || [ -n "${HC_RELAY_URL:-}" ]; then
  LOCAL_BOOTSTRAP=0
fi

die() { echo "run.sh: FAIL $*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1 (see README prerequisites)"; }
port_free() { ! ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }

BOOTSRV=""
find_bootsrv() {
  if [ -n "${KITSUNE2_BOOTSTRAP_SRV:-}" ]; then
    BOOTSRV=$KITSUNE2_BOOTSTRAP_SRV
  elif command -v kitsune2-bootstrap-srv >/dev/null 2>&1; then
    BOOTSRV=$(command -v kitsune2-bootstrap-srv)
  elif [ -x /home/data/code/acorn-spike/tools/bin/kitsune2-bootstrap-srv ]; then
    BOOTSRV=/home/data/code/acorn-spike/tools/bin/kitsune2-bootstrap-srv
  else
    die "kitsune2-bootstrap-srv not found — set KITSUNE2_BOOTSTRAP_SRV or put it on PATH (README lists the step-0 tools dir)"
  fi
  [ -x "$BOOTSRV" ] || die "KITSUNE2_BOOTSTRAP_SRV not executable: $BOOTSRV"
}

preflight() {
  # AD4M_EXECUTOR first — the --check test's break check removes this block.
  if [ -z "${AD4M_EXECUTOR:-}" ]; then
    die "AD4M_EXECUTOR is required (path to the ad4m-executor binary)"
  fi
  [ -x "$AD4M_EXECUTOR" ] || die "AD4M_EXECUTOR not executable: $AD4M_EXECUTOR"

  if [ "$LOCAL_BOOTSTRAP" = 0 ]; then
    [ -n "${HC_BOOTSTRAP_URL:-}" ] && [ -n "${HC_RELAY_URL:-}" ] ||
      die "set BOTH HC_BOOTSTRAP_URL and HC_RELAY_URL, or neither for the local bootstrap"
  else
    find_bootsrv
  fi

  [ -f "$ROOT/language/vendor/acorn.happ" ] || die "missing $ROOT/language/vendor/acorn.happ"
  [ -f "$ACORN_UI/web/package.json" ] ||
    die "ACORN_UI has no web/package.json: $ACORN_UI (set ACORN_UI to the acorn-ad4m-ui checkout, branch ad4m/c3-live-updates)"

  need_cmd node; need_cmd python3; need_cmd yarn; need_cmd pnpm
  need_cmd curl; need_cmd ss

  [ "$LOCAL_BOOTSTRAP" = 1 ] && { port_free "$BOOT_PORT" ||
    die "port $BOOT_PORT already in use — set BOOT_PORT to move, or stop the other bootstrap/rig"; }
  port_free "$AD4M_PORT" ||
    die "port $AD4M_PORT already in use — set AD4M_PORT to move, or stop what holds it"
  port_free "$WEB_PORT" ||
    die "port $WEB_PORT already in use — set WEB_PORT to move, or stop what holds it"
}

bootstrap_desc() {
  if [ "$LOCAL_BOOTSTRAP" = 1 ]; then
    echo "local kitsune2 bootstrap+relay on http://127.0.0.1:$BOOT_PORT ($BOOTSRV)"
  else
    echo "external: HC_BOOTSTRAP_URL=$HC_BOOTSTRAP_URL HC_RELAY_URL=$HC_RELAY_URL"
  fi
}

print_plan() {
  cat <<EOF
run.sh --check: inputs are valid; this is the plan, nothing started.

  inputs:
    AD4M_EXECUTOR  ${AD4M_EXECUTOR:-<unset>}
    ACORN_UI       $ACORN_UI
    AD4M_PORT      $AD4M_PORT
    WEB_PORT       $WEB_PORT
    DATA_DIR       $DATA_DIR (kept between runs; --fresh wipes it)
    AGENT_PASS     <set>
    bootstrap      $(bootstrap_desc)

  step 1/5  bootstrap  — start the local kitsune2 bootstrap+relay
                       (skipped when HC_BOOTSTRAP_URL/HC_RELAY_URL are set)
  step 2/5  executor   — ad4m-executor init on first run, then run on port $AD4M_PORT
  step 3/5  agent      — agent.generate on first run, agent.unlock after
  step 4/5  language   — build language/, publish the base bundle locally,
                       warm up the conductor (one applyTemplateLocal)
  step 5/5  ui         — yarn build with ACORN_LANGUAGE_ADDRESS, serve
                       web/dist on :$WEB_PORT, print the ?ad4m= URL

  UI URL will be:
    http://localhost:$WEB_PORT/?ad4m=ws://127.0.0.1:$AD4M_PORT/api/v1/ws
EOF
}

### --check: validate, print the plan, start nothing.
preflight
if [ "$CHECK_ONLY" = 1 ]; then
  print_plan
  exit 0
fi

### real run
[ "$FRESH" = 1 ] && rm -rf "$DATA_DIR"
mkdir -p "$RUN_DIR" "$DATA_DIR"

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  echo "run.sh: stopping"
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  echo "run.sh: stopped"
}
trap cleanup INT TERM EXIT

wait_health() { # <url> <name> [tries]
  local i
  for i in $(seq 1 "${3:-60}"); do
    curl -sf "$1" > /dev/null 2>&1 && return 0
    sleep 1
  done
  die "$2 did not come up at $1 (logs in $RUN_DIR)"
}

step() { echo; echo "run.sh: step $1/5 — $2"; }

### step 1: bootstrap
if [ "$LOCAL_BOOTSTRAP" = 1 ]; then
  step 1 "local bootstrap on 127.0.0.1:$BOOT_PORT"
  "$BOOTSRV" --listen "127.0.0.1:$BOOT_PORT" > "$RUN_DIR/bootsrv.log" 2>&1 &
  PIDS+=($!)
  wait_health "http://127.0.0.1:$BOOT_PORT/health" "bootstrap" 20
  HC_BOOTSTRAP_URL="http://127.0.0.1:$BOOT_PORT"
  HC_RELAY_URL="http://127.0.0.1:$BOOT_PORT/relay"
else
  step 1 "skipped — external HC servers configured"
fi

### step 2: executor
step 2 "executor on :$AD4M_PORT (data $DATA_DIR)"
if [ ! -f "$DATA_DIR/mainnet_seed.seed" ]; then
  "$AD4M_EXECUTOR" init -d "$DATA_DIR" > "$RUN_DIR/init.log" 2>&1 ||
    die "executor init failed (see $RUN_DIR/init.log)"
fi
"$AD4M_EXECUTOR" run -a "$DATA_DIR" --port "$AD4M_PORT" --localhost true \
  --insecure-no-admin-credential \
  --hc-bootstrap-url "$HC_BOOTSTRAP_URL" \
  --hc-relay-url "$HC_RELAY_URL" \
  --hc-use-proxy false --run-dapp-server false --enable-mcp false \
  > "$RUN_DIR/executor.log" 2>&1 &
PIDS+=($!)
wait_health "http://127.0.0.1:$AD4M_PORT/health" "executor api" 60

# the rig drivers read the port/data dir from env (process.env wins over
# rig/.run/env — a stale rig env can point at another rig's data dir)
export AD4M_PORT AD4M_DATA=$DATA_DIR

### step 3: agent
step 3 "agent (generate on first run, unlock after)"
[ -d "$ROOT/rig/node_modules" ] || (cd "$ROOT/rig" && pnpm install) ||
  die "rig pnpm install failed"
node "$ROOT/rig/ad4m.mjs" ensureagent "$AGENT_PASS" > "$RUN_DIR/agent.log" 2>&1 || {
  sed -n '1,10p' "$RUN_DIR/agent.log" | sed 's/^/    /' >&2
  die "agent step failed (see $RUN_DIR/agent.log)"
}
AD4M_DID=$(python3 -c "import json; print(json.loads(open('$RUN_DIR/agent.log').read().strip().splitlines()[-1])['did'])" 2>/dev/null || echo "?")
echo "run.sh: agent $AD4M_DID"

### step 4: language
step 4 "build + publish the base Acorn language"
[ -d "$ROOT/language/node_modules" ] || (cd "$ROOT/language" && pnpm install) ||
  die "language pnpm install failed"
(cd "$ROOT/language" && node build.mjs) > "$RUN_DIR/language-build.log" 2>&1 ||
  die "language build failed (see $RUN_DIR/language-build.log)"
ADDR=$(node "$ROOT/rig/ad4m.mjs" publish "$ROOT/language/build/bundle.js") ||
  die "publish of the base bundle failed"
echo "run.sh: base language address $ADDR"
node "$ROOT/rig/ad4m.mjs" warmup "$ADDR" > "$RUN_DIR/warmup.log" 2>&1 || {
  sed -n '1,10p' "$RUN_DIR/warmup.log" | sed 's/^/    /' >&2
  die "conductor never accepted the Acorn DNA (see $RUN_DIR/warmup.log)"
}

### step 5: ui
step 5 "build + serve the Acorn UI on :$WEB_PORT"
[ -d "$ACORN_UI/node_modules" ] ||
  (cd "$ACORN_UI" && yarn install --frozen-lockfile) ||
  die "ui yarn install failed"
(cd "$ACORN_UI/web" && ACORN_LANGUAGE_ADDRESS="$ADDR" yarn build) \
  > "$RUN_DIR/ui-build.log" 2>&1 ||
  die "ui build failed (see $RUN_DIR/ui-build.log)"
python3 -m http.server "$WEB_PORT" --bind 127.0.0.1 \
  --directory "$ACORN_UI/web/dist" > "$RUN_DIR/ui-server.log" 2>&1 &
PIDS+=($!)
wait_health "http://127.0.0.1:$WEB_PORT/" "ui server" 15

cat <<EOF

run.sh: everything is up — Ctrl-C stops all of it.

  executor api : ws://127.0.0.1:$AD4M_PORT/api/v1/ws   (agent $AD4M_DID)
  acorn lang   : $ADDR
  Open this UI : http://localhost:$WEB_PORT/?ad4m=ws://127.0.0.1:$AD4M_PORT/api/v1/ws

  Join a project with its passphrase ("Join existing project" on the
  dashboard); the project uid is 'uid-' + passphrase.words.join('-').
  Logs: $RUN_DIR/*.log

EOF

# wait for the first child to die (Ctrl-C -> cleanup -> kill the rest)
wait -n 2>/dev/null
echo "run.sh: a child exited — tearing down"
