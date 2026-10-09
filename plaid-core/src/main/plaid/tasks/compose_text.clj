(ns plaid.tasks.compose-text
  "One-off conversion of a database to composed text (Unicode NFC).

  Core stores all text composed at write time (Luke, 2026-10-09), and text
  stored before that is converted by this task, once, with the server
  stopped. A text body is composed with every token on it moved by
  `plaid.util.canonical/compose`, so each token keeps the text it covered.
  Every other text column is composed too: names, vocabulary forms, span and
  relation values, metadata keys and values, layer and project configs and
  constraints, guidelines, comments, display names, API token and invite
  labels. Left alone: private user data (the app's own state), passwords,
  client events, service registrations and the audit history, which is never
  rewritten.

  Usage, from the directory holding the jar:

      java -cp plaid.jar clojure.main -m plaid.tasks.compose-text /path/to/plaid.db
      java -cp plaid.jar clojure.main -m plaid.tasks.compose-text /path/to/plaid.db --apply

  The first is a dry run: it reads, and reports what would change as counts.
  It never prints stored text. `--apply` takes the database's instance lock
  (so it refuses while a server is running on it) and writes everything as
  ONE operation (`:text/compose`, in an operation group of kind `repair`, so
  no document reads as edited by it), attributed to the first admin, through
  the audited writers: every changed row has its audit row, and every
  document whose rows changed has its version bumped. A database already
  composed writes nothing. `--apply` first brings the schema up to this
  core's (the migrations a first start runs), so the conversion runs with
  the old server stopped and before the new one starts, and no edit lands
  in between."
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.datasource :as psd]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.server.sql :as server-sql]
            [plaid.util.canonical :as canonical]
            [migratus.core :as migratus]
            [taoensso.timbre :as log])
  (:import (java.text Normalizer Normalizer$Form))
  (:refer-clojure :exclude [run!]))

(defn- composed? [^String s] (Normalizer/isNormalized s Normalizer$Form/NFC))

(def ^:private non-ascii
  "SQL for a TEXT column holding a character outside ASCII."
  "length(%s) <> length(CAST(%s AS BLOB))")

(def ^:private escaped-or-non-ascii
  "SQL for a JSON column holding a character outside ASCII, escaped (the
  JSON writer writes `\\u00e1`) or not."
  "(instr(%s, '\\u') > 0 OR length(%s) <> length(CAST(%s AS BLOB)))")

(defn- where [fmt col] (let [c (name col)] (apply format fmt (repeat 3 c))))

;; ============================================================
;; What changes
;; ============================================================

(def ^:private text-columns
  "Plain text columns: `[table column audited?]`. Comments and invites are
  written unaudited by core, and stay so."
  [[:projects :name true] [:documents :name true] [:text_layers :name true] [:token_layers :name true]
   [:span_layers :name true] [:relation_layers :name true] [:vocab_layers :name true]
   [:vocab_items :form true] [:guidelines :title true] [:guidelines :body true]
   [:users :display_name true] [:api_tokens :name true]
   [:comments :body false] [:comments :anchor_label false] [:invites :note false]])

(def ^:private json-columns
  "JSON columns: `[table column serializer]`."
  [[:projects :config psc/serialize-config] [:text_layers :config psc/serialize-config]
   [:token_layers :config psc/serialize-config] [:span_layers :config psc/serialize-config]
   [:relation_layers :config psc/serialize-config] [:vocab_layers :config psc/serialize-config]
   [:token_layers :constraints psc/write-json] [:span_layers :constraints psc/write-json]
   [:relation_layers :constraints psc/write-json]
   [:spans :value psc/write-json] [:relations :value psc/write-json]])

(defn- compose-json [s write]
  (let [v (json/read-str s)
        v' (canonical/compose-data v (constantly false))]
    (when-not (identical? v v') (write v'))))

(defn- rows [db table col fmt]
  ;; `users` has a text id: a map query keeps it a string
  (psc/q db {:select [:id col] :from [table] :where [:raw (where fmt col)]}))

(defn- column-changes
  "`{[table column] [[id new-value] ...]}` for every column above."
  [db]
  (merge
   (into {} (for [[table col] text-columns
                  :let [changes (vec (for [r (rows db table col non-ascii)
                                           :let [v (get r col)]
                                           :when (and (string? v) (not (composed? v)))]
                                       [(:id r) (canonical/nfc v)]))]
                  :when (seq changes)]
              [[table col] changes]))
   (into {} (for [[table col write] json-columns
                  :let [changes (vec (for [r (rows db table col escaped-or-non-ascii)
                                           :let [v (get r col)
                                                 v' (when (string? v) (compose-json v write))]
                                           :when v']
                                       [(:id r) v']))]
                  :when (seq changes)]
              [[table col] changes]))))

(defn- body-changes
  "For every text whose body is not composed: the composed body and the
  tokens it moves, `{:id :document :body :tokens [[id {:begin :end_}] ...]
  :zero-width n}`."
  [db]
  (vec (for [t (psc/q db {:select [:id :document_id :body] :from [:texts]
                          :where [:raw (where non-ascii :body)]})
             :when (not (composed? (:body t)))]
         (let [{body :text at :at} (canonical/compose (:body t))
               moved (vec (for [tok (psc/q db {:select [:id :begin :end_] :from [:tokens]
                                               :where [:= :text_id (:id t)]
                                               :order-by [:begin :id]})
                                :let [b (at (:begin tok)) e (at (:end_ tok))]
                                :when (or (not= b (:begin tok)) (not= e (:end_ tok)))]
                            [(:id tok) {:begin b :end_ e} (and (< (:begin tok) (:end_ tok)) (= b e))]))]
           {:id (:id t) :document (:document_id t) :body body
            :tokens (mapv pop moved)
            :zero-width (count (filter peek moved))}))))

(defn- metadata-changes
  "`[{:type :id :metadata composed :merged n}]` for every entity with a
  metadata key or value that is not composed. `:merged` counts keys that
  compose to a key the entity already has, which become one."
  [db]
  (let [hits (psc/q db {:select-distinct [:entity_type :entity_id] :from [:entity_metadata]
                        :where [:or [:raw (where non-ascii :key)] [:raw (where escaped-or-non-ascii :value)]]})]
    (vec (for [{:keys [entity_type entity_id]} hits
               :let [m (metadata/get-metadata db entity_type entity_id)
                     m' (canonical/compose-data m (constantly false))]
               :when (not (identical? m m'))]
           {:type entity_type :id entity_id :metadata m' :merged (- (count m) (count m'))}))))

(defn plan
  "Everything the conversion would write, read from `db`."
  [db]
  {:bodies (body-changes db)
   :columns (column-changes db)
   :metadata (metadata-changes db)})

;; ============================================================
;; Documents a change restates
;; ============================================================

(def ^:private document-tables #{:texts :tokens :spans :relations :vocab_links})

(defn- documents-of [tx {:keys [bodies columns metadata]}]
  (let [doc-of (fn [table id]
                 (cond
                   (= table :documents) [id]
                   (document-tables table) [(:document_id (psc/fetch-by-id tx table id))]
                   ;; a deep read carries an entry's form and fields on its links
                   (= table :vocab_items) (map :document_id (psc/q tx {:select [:document_id] :from [:vocab_links]
                                                                       :where [:= :vocab_item_id id]}))
                   :else nil))]
    (->> (concat (map :document bodies)
                 (for [[[table _] changes] columns
                       [id _] changes
                       d (doc-of table id)]
                   d)
                 (for [{:keys [type id]} metadata
                       d (doc-of (metadata/entity-type->table type) id)]
                   d))
         (remove nil?)
         distinct
         vec)))

;; ============================================================
;; Writing
;; ============================================================

(def ^:private audited
  (into {} (map (fn [[t c a]] [[t c] a])) text-columns))

(defn- apply-plan! [tx {:keys [bodies columns metadata] :as p}]
  (let [docs (documents-of tx p)]
    (doseq [{:keys [id body tokens]} bodies]
      (when (seq tokens) (crud/bulk-update-by-id! tx :tokens tokens))
      (crud/update-by-id! tx :texts id {:body body}))
    (doseq [[[table col] changes] (sort-by (comp str key) columns)
            [id v] changes]
      (if (get audited [table col] true)
        (crud/update-by-id! tx table id {col v})
        (psc/execute! tx {:update table :set {col v} :where [:= :id id]})))
    (doseq [{:keys [type id] m :metadata} metadata]
      (metadata/replace-metadata! tx type id m))
    (op/bump-document-versions! tx docs)
    docs))

(defn- counts [{:keys [bodies columns metadata]}]
  {:texts (count bodies)
   :tokens-moved (reduce + 0 (map (comp count :tokens) bodies))
   :tokens-left-zero-width (reduce + 0 (map :zero-width bodies))
   :columns (into (sorted-map) (map (fn [[[t c] ch]] [(str (name t) "." (name c)) (count ch)])) columns)
   :metadata-entities (count metadata)
   :metadata-keys-merged (reduce + 0 (map :merged metadata))})

(defn- nothing? [{:keys [bodies columns metadata]}]
  (and (empty? bodies) (empty? columns) (empty? metadata)))

(defn- first-admin [db]
  (:id (psc/q1 db {:select [:id] :from [:users] :where [:= :is_admin 1] :order-by [[:id :asc]] :limit 1})))

(defn run!
  "Convert `db` (a DataSource). Dry run unless `apply?`. Returns the counts,
  with `:documents` (how many documents' versions are bumped) and, when
  applied, `:operation` (its id)."
  [db apply?]
  (if-not apply?
    (let [p (plan db)] (assoc (counts p) :applied false))
    (let [user (or (first-admin db)
                   (throw (ex-info "No admin user to attribute the conversion to." {})))
          result (volatile! nil)
          answer (binding [op/*current-group-id* (psc/new-uuid)
                           op/*current-group-message* "Stored text composed (Unicode NFC)"
                           op/*current-group-kind* "repair"
                           ;; Not the outermost operation of a transaction:
                           ;; the layer rules are not checked at its end. The
                           ;; conversion moves no token past another, so it
                           ;; breaks no rule the data kept.
                           psaw/*pending* (atom {})]
                   (submit-operation!
                    [tx db {:type :text/compose
                            :project nil
                            :document nil
                            :description "Composed stored text (Unicode NFC)"
                            :user user
                            :skip-lock-check? true
                            :unrecorded-if-empty? true}]
                    (let [p (plan tx)]
                      (vreset! result (counts p))
                      (when-not (nothing? p)
                        (let [docs (apply-plan! tx p)]
                          (vswap! result assoc :documents (count docs)))))
                    (:id psaw/*op*)))]
      (when-not (:success answer)
        (throw (ex-info (str "The conversion was refused: " (:error answer)) {})))
      (cond-> (assoc @result :applied true)
        (:documents @result) (assoc :operation (str (:extra answer)))))))

;; ============================================================
;; Command line
;; ============================================================

(defn- lock!
  "The instance lock a server takes on `<db>.lock`, or a throw when a
  server holds it."
  [db-path]
  (let [f (java.io.File. (str db-path ".lock"))
        ch (.getChannel (java.io.RandomAccessFile. f "rw"))
        l (try (.tryLock ch) (catch java.nio.channels.OverlappingFileLockException _ nil))]
    (when-not l
      (.close ch)
      (throw (ex-info (str "A server holds " (.getPath f) ". Stop it first.") {})))
    [ch l]))

(defn -main [& args]
  (let [apply? (some #{"--apply"} args)
        [db-path & more] (remove #{"--apply"} args)]
    (when (or (nil? db-path) (seq more) (not (.isFile (java.io.File. ^String db-path))))
      (binding [*out* *err*]
        (println "Usage: clojure.main -m plaid.tasks.compose-text <database file> [--apply]"))
      (System/exit 2))
    (log/set-min-level! :error)
    (let [held (when apply?
                 (try (lock! db-path)
                      (catch clojure.lang.ExceptionInfo e
                        ;; a server is running on it: said plainly, nothing done
                        (binding [*out* *err*] (println (ex-message e)))
                        (System/exit 1))))
          ds (psd/build-datasource db-path {:max-pool-size 2})]
      (try
        ;; the schema this core writes, as its first start would leave it,
        ;; so the conversion can run before the new core ever serves
        (when apply? (migratus/migrate (server-sql/migratus-config ds)))
        (let [r (run! ds (boolean apply?))]
          (doseq [[k v] (dissoc r :columns)] (println (str (name k) ": " v)))
          (doseq [[k v] (:columns r)] (println (str "column " k ": " v))))
        (finally
          (.close ^java.io.Closeable ds)
          (when-let [[ch l] held]
            (.release ^java.nio.channels.FileLock l)
            (.close ^java.nio.channels.FileChannel ch))))
      (shutdown-agents)
      (System/exit 0))))
