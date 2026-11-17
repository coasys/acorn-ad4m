#!/usr/bin/env bash
# rig/start.sh — two-node rig: local kitsune2 bootstrap + stock Holochain
# 0.7.0 conductor (Acorn clone cell with $SEED) + AD4M executor.
# Fresh dirs under rig/.run/ every run. Writes rig/.run/env.
#
#   AD4M_EXECUTOR=<path>/ad4m-executor rig/start.sh
#
# Optional env: BOOT_PORT=45300 HC_ADMIN=45310 AD4M_PORT=45400
#               SEED=uid-rig-test-project AGENT_PASS=rig-passphrase
set -u
cd "$(dirname "$0")"
HERE=$PWD
ROOT="$HERE/.."
RUN="$HERE/.run"

BOOT_PORT=${BOOT_PORT:-45300}
HC_ADMIN=${HC_ADMIN:-45310}
AD4M_PORT=${AD4M_PORT:-45400}
SEED=${SEED:-uid-rig-test-project}
AGENT_PASS=${AGENT_PASS:-rig-passphrase}

TOOLS=/home/data/code/acorn-spike/tools/bin
HAPP="$ROOT/language/vendor/acorn.happ"

# drivers invoked below read these through envfile.mjs before .run/env exists
export BOOT_PORT HC_ADMIN AD4M_PORT SEED

if [ -z "${AD4M_EXECUTOR:-}" ]; then
  echo "start.sh: AD4M_EXECUTOR is required (path to the built executor)" >&2
  exit 1
fi
if [ ! -x "$AD4M_EXECUTOR" ]; then
  echo "start.sh: AD4M_EXECUTOR not executable: $AD4M_EXECUTOR" >&2
  exit 1
fi
if [ ! -f "$HAPP" ]; then
  echo "start.sh: missing $HAPP" >&2
  exit 1
fi

# Preflight: the rig ports must be free (another rig may be running).
for p in "$BOOT_PORT" "$HC_ADMIN" "$AD4M_PORT"; do
  if ss -ltn "sport = :$p" 2>/dev/null | grep -q LISTEN; then
    echo "start.sh: port $p already in use — set BOOT_PORT/HC_ADMIN/AD4M_PORT to move" >&2
    exit 1
  fi
done

# Stop leftovers from a previous run of THIS rig (recorded pids only).
bash "$HERE/stop.sh" >/dev/null 2>&1 || true

rm -rf "$RUN"
mkdir -p "$RUN/sideb/databases" "$RUN/sidea"

fail() { echo "start.sh: FAIL $*" >&2; bash "$HERE/stop.sh" >/dev/null 2>&1; exit 1; }

### 1. local kitsune2 bootstrap + relay
"$TOOLS/kitsune2-bootstrap-srv" --listen "127.0.0.1:$BOOT_PORT" > "$RUN/bootsrv.log" 2>&1 &
echo $! > "$RUN/bootsrv.pid"
sleep 2
curl -sf "http://127.0.0.1:$BOOT_PORT/health" > /dev/null || fail "bootstrap not healthy"
echo "start.sh: bootstrap+relay on 127.0.0.1:$BOOT_PORT"

### 2. stock holochain conductor
cat > "$RUN/sideb/conductor.yaml" <<YAML
data_root_path: $RUN/sideb/databases
keystore: { type: danger_test_keystore }
admin_interfaces:
  - driver: { type: websocket, port: $HC_ADMIN, allowed_origins: "*" }
network:
  bootstrap_url: http://127.0.0.1:$BOOT_PORT
  relay_url: http://127.0.0.1:$BOOT_PORT/relay
  advanced: { irohTransport: { relayAllowPlainText: true } }
YAML

"$TOOLS/holochain" -c "$RUN/sideb/conductor.yaml" --piped > "$RUN/stock.log" 2>&1 &
echo $! > "$RUN/stock.pid"
for i in $(seq 1 30); do
  grep -q 'Conductor ready' "$RUN/stock.log" 2>/dev/null && break
  sleep 1
done
grep -q 'Conductor ready' "$RUN/stock.log" || fail "stock conductor did not start (see $RUN/stock.log)"

# give the conductor a moment to join the bootstrap space before the clone
sleep 3
node "$HERE/stock.mjs" setup > "$RUN/stock-setup.log" 2>&1 || {
  sed -n '1,15p' "$RUN/stock-setup.log" | sed 's/^/    /' >&2
  fail "stock setup failed"
}
STOCK_DNA=$(python3 -c "import json;print(json.load(open('$RUN/stock-state.json'))['dnaHashB64'])")
STOCK_AGENT=$(python3 -c "import json;print(json.load(open('$RUN/stock-state.json'))['agentKeyB64'])")
STOCK_APP_PORT=$(python3 -c "import json;print(json.load(open('$RUN/stock-state.json'))['appPort'])")
echo "start.sh: stock cell dna=$STOCK_DNA agent=$STOCK_AGENT"

### 3. ad4m executor
"$AD4M_EXECUTOR" init -d "$RUN/sidea/data" > "$RUN/init.log" 2>&1 || fail "executor init failed"
"$AD4M_EXECUTOR" run -a "$RUN/sidea/data" --port "$AD4M_PORT" --localhost true \
  --insecure-no-admin-credential \
  --hc-bootstrap-url "http://127.0.0.1:$BOOT_PORT" \
  --hc-relay-url "http://127.0.0.1:$BOOT_PORT/relay" \
  --hc-use-proxy false --run-dapp-server false --enable-mcp false \
  > "$RUN/executor.log" 2>&1 &
echo $! > "$RUN/executor.pid"

for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$AD4M_PORT/health" > /dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:$AD4M_PORT/health" > /dev/null 2>&1 || fail "executor api did not come up (see $RUN/executor.log)"

node "$HERE/ad4m.mjs" generate "$AGENT_PASS" > "$RUN/agent.log" 2>&1 || {
  sed -n '1,15p' "$RUN/agent.log" | sed 's/^/    /' >&2
  fail "agent.generate failed"
}
AD4M_DID=$(python3 -c "import json;print(json.loads(open('$RUN/agent.log').read().split(':',1)[1].strip())['did'])" 2>/dev/null || echo "")

### 4. env file
cat > "$RUN/env" <<ENV
BOOT_PORT=$BOOT_PORT
HC_ADMIN=$HC_ADMIN
AD4M_PORT=$AD4M_PORT
SEED=$SEED
STOCK_DNA=$STOCK_DNA
STOCK_AGENT=$STOCK_AGENT
STOCK_APP_PORT=$STOCK_APP_PORT
AD4M_DATA=$RUN/sidea/data
AD4M_AGENT_DID=$AD4M_DID
ENV

echo "start.sh: rig up — env at $RUN/env"
