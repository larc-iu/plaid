(ns plaid.server.version
  "The release version this server reports.

  Its own namespace because two things need it and they sit on opposite
  sides of a require cycle: `plaid.server.middleware` (which serves
  /health) already requires the REST router, so a REST namespace cannot
  require it back."
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]))

(def version
  "Read from `version.edn` on the classpath, which the release workflow
  (.github/workflows/release.yml) writes into the jar from the git tag at
  build time. Absent in local / unreleased runs, where we report \"dev\"."
  (or (try
        (some-> (io/resource "version.edn")
                slurp
                (edn/read-string)
                :version)
        (catch Exception _ nil))
      "dev"))
