#!/bin/bash -

set -euo pipefail

# dirt cheap DCE
write_prn_file() {
  echo "(ns glam.client.prn-debug
  (:require [clojure.pprint :as pprint]))

;;
;; Hello.
;;
;; I'm generated in the scripts/start_dev.sh script so I won't show up in production builds.
;; See scripts/build_prod.sh for the release version of this namespace.
;;
;;

(defn ^:export pprint-str [v] (with-out-str (pprint/pprint v)))
(defn ^:export pprint [v] (pprint/pprint v))

;; To use from within the browser dev tools console
(set! js/pprint_str pprint-str)
(set! js/pprint pprint)
" > src/main/glam/client/prn_debug.cljs
}

main() {
  write_prn_file

  echo yarn install
  yarn install

  echo '
  Greetings. I trust you will have an excellent day.


  Starting shadow-cljs watches for you via the following command:

  yarn run shadow-cljs watch main test workspaces

  # shadow-cljs builds:
  http://localhost:9630

  # Frontend app
  start nrepl to shadow-cljs port (see shadow-cljs.edn) then connect with:
  (shadow/repl :main)

  # Backend
  1. Start clj repl for backend in your editor and then execute:
  (user/start)

  # Tests
 http://localhost:8022

 # Workspaces
 http://localhost:8023
'

  yarn run shadow-cljs watch main test workspaces
}

main "$@"
