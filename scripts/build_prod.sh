#!/bin/bash -

set -eo pipefail

write_prn_file() {
  echo "(ns glam.client.prn-debug)(defn pprint-str [v])(defn pprint [v])" \
    > src/main/glam/client/prn_debug.cljs
}

main() {
  write_prn_file

  echo yarn run client/release
  yarn run client/release
  echo yarn uberjar
  yarn uberjar
  if [[ "$1" = "run" ]]; then
    echo "running"
    yarn run start-prod-server
  fi
  echo "done"
}

main "$@"
