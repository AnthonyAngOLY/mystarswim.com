#!/usr/bin/env bash
# Every suite, or one by name.
#   bash tests/run.sh            everything
#   bash tests/run.sh intake     one suite
#
# A suite is tests/<name>.test.js. If tests/<name>mock.js exists it is
# started first and stopped after; a suite without one needs no server.
set -u
cd "$(dirname "$0")/.."
only="${1:-}"
fail=0
for t in tests/*.test.js; do
  name=$(basename "$t" .test.js)
  [ -n "$only" ] && [ "$only" != "$name" ] && continue
  echo "===== $(basename "$t")"
  mock="tests/${name}mock.js"
  pid=""
  if [ -f "$mock" ]; then
    node "$mock" > "/tmp/$name-mock.log" 2>&1 &
    pid=$!
    sleep 1
  fi
  node "$t" || fail=1
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  fi
done
exit $fail
