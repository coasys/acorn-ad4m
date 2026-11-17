#!/usr/bin/env bash
# test/run-script.test.sh — `run.sh --check` validates inputs and ports and
# prints the plan without starting anything.
set -u
cd "$(dirname "$0")/.."
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

### 1. AD4M_EXECUTOR unset -> non-zero exit, message names AD4M_EXECUTOR
out=$(env -u AD4M_EXECUTOR ./run.sh --check 2>&1); rc=$?
if [ $rc -ne 0 ]; then ok "AD4M_EXECUTOR unset: exit $rc"; else bad "AD4M_EXECUTOR unset: exit was 0"; fi
if echo "$out" | grep -q "AD4M_EXECUTOR"; then
  ok "message names AD4M_EXECUTOR"
else
  bad "message does not name AD4M_EXECUTOR: $out"
fi

### 2. dummy executable -> exit 0, plan lists the five steps
dummy=$(mktemp -d)/ad4m-executor
printf '#!/bin/sh\nexit 0\n' > "$dummy"; chmod +x "$dummy"
out=$(AD4M_EXECUTOR="$dummy" AD4M_PORT=47600 WEB_PORT=47601 BOOT_PORT=47602 \
      ./run.sh --check 2>&1); rc=$?
if [ $rc -eq 0 ]; then ok "dummy executor: exit 0"; else bad "dummy executor: exit $rc"; echo "$out"; fi
for s in 1 2 3 4 5; do
  if echo "$out" | grep -q "step $s/5"; then ok "plan lists step $s/5"; else bad "plan missing step $s/5"; fi
done
if echo "$out" | grep -qi "nothing"; then ok "plan says nothing starts"; else bad "plan does not say it is a dry run"; fi

### 3. nothing was started: the test ports must still be free
for p in 47600 47601 47602; do
  if ss -ltn "sport = :$p" 2>/dev/null | grep -q LISTEN; then
    bad "port $p is bound after --check"
  else
    ok "port $p still free"
  fi
done

echo
if [ $fail -eq 0 ]; then echo "run-script.test.sh: PASS"; else echo "run-script.test.sh: FAILED"; fi
exit $fail
