(ns plaid.server.paths
  "Where the server's on-disk state lives.

  Everything that is not in the database (uploaded media, extracted service
  scripts, the config file itself) sits under one data directory. Under
  SQLite that directory is simply the parent of the database file, which is
  how the default `data/` layout arises with no configuration at all. Postgres
  has no local file to take a parent from, so `[database] data_dir` names the
  directory explicitly (and may be set on SQLite too, to split the two)."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [plaid.server.config :refer [config]])
  (:import (java.io File)))

(def ^:private default-data-dir "data")

(defn data-dir-file
  "The data directory as a `java.io.File`. Resolution order:
    1. `[database] data_dir`, when set;
    2. the parent directory of `[database] path` (SQLite's database file);
    3. `./data`.

  Rule 2 is what makes the zero-config SQLite layout work: `path =
  \"data/plaid.db\"` puts media and services in `data/` without the operator
  saying so. A bare filename (`path = \"plaid.db\"`) has no parent, so it
  falls through to rule 3."
  (^File [] (data-dir-file config))
  (^File [cfg]
   (let [db-cfg (:plaid.server.sql/config cfg)
         explicit (:data-dir db-cfg)]
     (cond
       (not (str/blank? explicit)) (io/file explicit)
       :else (or (some-> (:main-db-path db-cfg) not-empty io/file .getParentFile)
                 (io/file default-data-dir))))))

(defn data-dir
  "`data-dir-file` as a path string."
  (^String [] (.getPath (data-dir-file)))
  (^String [cfg] (.getPath (data-dir-file cfg))))
