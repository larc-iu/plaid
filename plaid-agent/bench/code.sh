#!/bin/bash
# usage: code.sh [REV]   (default HEAD of this checkout, or of $PLAID_REPO)
# Snapshots plaid-core, plaid-agent and plaid-client-py at REV into code/<sha>/
# of the data directory ($PLAID_BENCH_DATA, default ~/.local/share/plaid-bench)
# (and the JS igt's tagset write runs on, below)
# with `git archive` (the working tree is never touched), builds the core
# uberjar there, and records <sha> in code/CURRENT. run.py and build.sh run
# the code named in code/CURRENT unless given --code.
set -e
B=${PLAID_BENCH_DATA:-$HOME/.local/share/plaid-bench}
REPO=${PLAID_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}
REV=${1:-HEAD}
SHA=$(git -C "$REPO" rev-parse --short=9 "$REV")
D=$B/code/$SHA
if [ ! -f "$D/plaid-core/target/plaid.jar" ]; then
  mkdir -p "$D"
  git -C "$REPO" archive "$SHA" plaid-core plaid-agent plaid-client-py | tar -x -C "$D"
  export PATH=$HOME/.local/bin:$PATH
  (cd "$D/plaid-core" && nice clojure -X:uberjar > "$D/uberjar.log" 2>&1) || { echo "uberjar build failed, see $D/uberjar.log" >&2; exit 1; }
fi
# igt's own write of a plan the app writes itself (tagset changes), which
# lib/panel.py runs under node: plaid-agent/tests/tagset_page_write.mjs reads
# plaid-igt, plaid-ui and plaid-client-js beside it, and the apps import the
# client by its package name, linked to the snapshot's own.
if [ ! -d "$D/plaid-igt/src" ]; then
  git -C "$REPO" archive "$SHA" plaid-igt/src plaid-igt/package.json plaid-ui/src plaid-ui/package.json plaid-client-js/src plaid-client-js/package.json | tar -x -C "$D"
  for app in plaid-igt plaid-ui; do
    mkdir -p "$D/$app/node_modules/@larc-iu"
    ln -sfn ../../../plaid-client-js "$D/$app/node_modules/@larc-iu/plaid-client"
  done
fi
echo "$SHA" > "$B/code/CURRENT"
echo "code: $D"
