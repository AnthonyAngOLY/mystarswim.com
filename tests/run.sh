#!/usr/bin/env bash
# Start each mock, run its tests against it, stop it again.
#   bash tests/run.sh            everything
#   bash tests/run.sh intake     one suite
set -u
cd "$(dirname "$0")/.."
only="${1:-}"
fail=0
for mock in tests/*mock.js; do
  name=$(basename "$mock" mock.js)
  [ -n "$only" ] && [ "$only" != "$name" ] && continue
  node "$mock" > "/tmp/$name-mock.log" 2>&1 &
  pid=$!
  sleep 1
  for t in tests/"$name".test.js; do
    [ -f "$t" ] || continue
    echo "===== $(basename "$t")"
    node "$t" || fail=1
  done
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
done
exit $fail
