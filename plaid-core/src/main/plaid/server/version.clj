(ns plaid.server.version
  "The release version this server reports, and the commit it was built from.

  Its own namespace because two things need it and they sit on opposite
  sides of a require cycle: `plaid.server.middleware` (which serves
  /health) already requires the REST router, so a REST namespace cannot
  require it back."
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]))

(def ^:private build
  "`version.edn` on the classpath, which `bb build` (bb/pipeline.clj, run by
  the release workflow .github/workflows/release.yml) writes into the jar:
  `{:version <from the git tag> :commit <the commit it was built from>}`.
  Absent in local / unreleased runs."
  (try
    (some-> (io/resource "version.edn") slurp edn/read-string)
    (catch Exception _ nil)))

(def version
  "The release version, \"dev\" in a run from source."
  (or (:version build) "dev"))

(def commit
  "The full hash of the commit the jar was built from, nil in a run from
  source."
  (:commit build))
