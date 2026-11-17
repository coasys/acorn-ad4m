#!/usr/bin/env bash
# rig/stop.sh — stop the processes this rig started. Kills only the pids
# recorded under rig/.run/*.pid, after checking /proc cmdline still names
# our binaries/paths (never pkill by name: other rigs run the same tools).
set -u
cd "$(dirname "$0")"
RUN=$PWD/.run

# read recorded pids -> name:pid map, dropping stale entries
declare -A PIDS=()
for name in executor stock bootsrv; do
  f="$RUN/$name.pid"
  [ -f "$f" ] || continue
  pid=$(cat "$f" 2>/dev/null || true)
  [ -n "$pid" ] && PIDS[$name]=$pid
done

ours() { # <name> <pid> — cmdline must still match the expected binary
  local name="$1" pid="$2" pat
  case "$name" in
    executor) pat="ad4m-executor" ;;
    stock)    pat="holochain" ;;
    bootsrv)  pat="kitsune2-bootstrap-srv" ;;
  esac
  kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "$pat"
}

for name in "${!PIDS[@]}"; do
  pid=${PIDS[$name]}
  if ours "$name" "$pid"; then kill -TERM "$pid" 2>/dev/null; fi
done

sleep 2

for name in "${!PIDS[@]}"; do
  pid=${PIDS[$name]}
  if ours "$name" "$pid"; then
    echo "stop.sh: $name ($pid) survived TERM — SIGKILL"
    kill -KILL "$pid" 2>/dev/null
  fi
  rm -f "$RUN/$name.pid"
done

echo "stop.sh: done"
