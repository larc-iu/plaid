#!/bin/bash
# usage: fixtures/build.sh
# Makes fixtures/snapshot/ (the database every run starts from) from the
# public data in fixtures/src/. See build.py for the steps. Needs code.sh run
# once first (code/CURRENT names the core jar and agent code used).
set -e
H=$(cd "$(dirname "$0")" && pwd)
# Node 24 or later: PLAID_NODE, else the first node on PATH (nvm's 24 when
# NVM_DIR names an nvm install).
if [ -z "${PLAID_NODE:-}" ] && [ -s "${NVM_DIR:-}/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh" >/dev/null
  nvm use 24 >/dev/null
fi
exec "${PLAID_AGENT_PYTHON:?set PLAID_AGENT_PYTHON to the python of the plaid-agent env}" "$H/build.py" "$@"
