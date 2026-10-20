(ns plaid.sql.audit-lazy-rebuild-test
  "The rebuild of `audit_writes` for lazy import rows (migration
  20261020130000): it removes exactly the insert rows core no longer
  writes, strips `id` and `document_id` from every image, and leaves every
  as-of read and restore as it was."
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [migratus.core :as migratus]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin assert-ok assert-no-content with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.history.restore :as restore]
            [plaid.history.unrecorded-rows-test :as unrec]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.datasource :as psd]
            [plaid.sql.operation :refer [submit-operation!]]
            [plaid.test-helpers :refer :all])
  (:import (java.io File)))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(def ^:private migration 20261020130000)

(defn- cfg [ds] {:store :database :migration-dir "migrations" :db {:datasource ds}})

(defn- ts [n] (format "2026-10-01T00:00:%02d.000000000Z" n))

(defn- rows-of [ds]
  (jdbc/execute! ds ["SELECT * FROM audit_writes ORDER BY id"] {:builder-fn rs/as-unqualified-maps}))

(deftest the-rebuild-removes-exactly-the-rows-core-no-longer-writes
  (let [path (temp-db-path)
        ds (psd/build-datasource path)]
    (try
      (migratus/migrate-until-just-before (cfg ds) migration)
      (with-open [c (jdbc/get-connection ds)]
        (jdbc/execute! c ["PRAGMA foreign_keys = OFF"])
        (let [op! (fn [id n group]
                    (jdbc/execute! c ["INSERT INTO operations (id, op_type, ts, group_id) VALUES (?, 'x/create', ?, ?)"
                                      id (ts n) group]))
              row! (fn [op-id seq table target change n doc & [image]]
                     (jdbc/execute! c ["INSERT INTO audit_writes (op_id, seq, target_table, target_id, change_type, post_image, ts, document_id) VALUES (?,?,?,?,?,?,?,?)"
                                       op-id seq table target change
                                       (when-not (= change "delete")
                                         (json/write-str (merge {"id" target "document_id" doc "v" 1} image)))
                                       (ts n) doc]))
              live! (fn [table id doc]
                      (case table
                        "spans" (jdbc/execute! c ["INSERT INTO spans (id, span_layer_id, document_id, value) VALUES (?, 'sl', ?, NULL)" id doc])
                        "tokens" (jdbc/execute! c ["INSERT INTO tokens (id, text_id, token_layer_id, document_id, begin, end_) VALUES (?, 'x', 'tl', ?, 0, 1)" id doc])))]
          (op! "c1" 1 "g1") (op! "c2" 2 "g1") (op! "o3" 3 nil) (op! "c4" 4 "g1")
          (op! "c5" 5 nil) (op! "o6" 6 nil)
          ;; d1, made by group g1
          (row! "c1" 0 "documents" "d1" "insert" 1 "d1")
          (row! "c2" 0 "spans" "s-alone" "insert" 2 "d1") (live! "spans" "s-alone" "d1")
          (row! "c2" 1 "spans" "s-edited" "insert" 2 "d1") (live! "spans" "s-edited" "d1")
          (row! "c2" 2 "spans" "s-gone" "insert" 2 "d1")
          (row! "o3" 0 "spans" "s-edited" "update" 3 "d1")
          (row! "c4" 0 "tokens" "t-late" "insert" 4 "d1") (live! "tokens" "t-late" "d1")
          ;; d2, made by an operation with no group
          (row! "c5" 0 "documents" "d2" "insert" 5 "d2")
          (row! "c5" 1 "tokens" "t-own" "insert" 5 "d2") (live! "tokens" "t-own" "d2")
          (row! "o6" 0 "tokens" "t-other" "insert" 6 "d2") (live! "tokens" "t-other" "d2")
          (row! "c5" 2 "vocab_items" "i1" "insert" 5 nil {"vocab_layer_id" "v1"})))
      (migratus/migrate (cfg ds))
      (let [rows (rows-of ds)]
        (testing "the only row of a row its document's group made before anyone else wrote the document goes"
          (is (= #{["documents" "d1"] ["spans" "s-edited"] ["spans" "s-gone"] ["tokens" "t-late"]
                   ["documents" "d2"] ["tokens" "t-other"] ["vocab_items" "i1"]}
                 (set (map (juxt :target_table :target_id) (filter #(= "insert" (:change_type %)) rows))))))
        (testing "a row with a second row, a row gone without a delete row, and rows after the window stay"
          (is (= 8 (count rows))))
        (testing "the rows keep their keys and order"
          (is (= (sort (map :id rows)) (map :id rows))))
        (testing "no image keeps an id or a document"
          (is (every? (fn [r] (let [m (json/read-str (:post_image r))]
                                (and (not (contains? m "id")) (not (contains? m "document_id")) (= 1 (get m "v")))))
                      (filter :post_image rows))))
        (testing "the indexes"
          (let [idx (into {} (map (juxt :name :sql))
                          (jdbc/execute! ds ["SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='audit_writes'"]
                                         {:builder-fn rs/as-unqualified-maps}))]
            (is (= #{"idx_audit_writes_op_seq" "idx_audit_writes_document_ts" "idx_audit_writes_target"
                     "idx_audit_writes_vocab_layer_ts" "idx_audit_writes_deleted"}
                   (set (keys idx))))
            (is (not (str/includes? (get idx "idx_audit_writes_target") "WHERE")))))
        (testing "no temporary table is left"
          (is (empty? (jdbc/execute! ds ["SELECT name FROM sqlite_temp_master WHERE type = 'table'"])))))
      (finally
        (.close ds)
        (doseq [suffix ["" "-wal" "-shm"]]
          (.delete (File. (str path suffix))))))))

;; ------------------------------------------------------------
;; Reads before and after, on a log core wrote
;; ------------------------------------------------------------

(defn- assert-ok-op [r] (is (:success r) (pr-str r)) r)

(defn- record-everything!
  "Write the insert row of every row of `doc-id` that has none, as the
  importers before lazy rows did, under the operation that created the
  document."
  [doc-id]
  (assert-ok-op
   (submit-operation! [tx db {:type :test/record :description "record" :user "admin@example.com"}]
                      (doseq [t (keys psaw/document-tables)]
                        (psaw/ensure-recorded! tx t (map :id (psc/q tx {:select [:id] :from [(keyword t)]
                                                                        :where [:= :document_id doc-id]})))))))

(defn- run-up-sql!
  "Run the migration's statements against the test database, in one
  connection, as migratus does."
  []
  (let [sql (slurp (io/resource (str "migrations/" migration "-audit-writes-lazy-rebuild.up.sql")))]
    (with-open [c (jdbc/get-connection db)]
      (jdbc/with-transaction [tx c]
        (doseq [stmt (str/split sql #"--;;")
                :when (not (str/blank? (str/replace stmt #"(?m)^--.*$" "")))]
          (jdbc/execute! tx [stmt]))))))

(defn- answers [doc times]
  (mapv (fn [t] [(hread/get-with-layer-data-at db doc t)
                 (some-> (hread/document-rows-at db doc t) (update-vals #(if (vector? %) (set %) %)))
                 (restore/preview db doc t)])
        times))

(deftest every-past-state-reads-the-same-after-the-rebuild
  (let [{:keys [proj tl tkl sl]} (let [p (create-test-project admin-request "Rebuild")
                                       tl (-> (create-text-layer admin-request p "TL") :body :id)
                                       tkl (-> (create-token-layer admin-request tl "TKL") :body :id)]
                                   {:proj p :tl tl :tkl tkl :sl (-> (create-span-layer admin-request tkl "SL") :body :id)})
        {:keys [doc spans tokens]} (unrec/grouped-document! (unrec/group-query "import") proj tl tkl sl "I"
                                                            ["A" "B" "C" "D"])
        made (latest-op-ts)
        _ (record-everything! doc)
        recorded (count (psc/q db ["SELECT 1 FROM audit_writes WHERE document_id = ? AND seq < 0" (str doc)]))
        _ (assert-ok (update-span admin-request (first spans) :value "AA"))
        edited (latest-op-ts)
        _ (assert-no-content (delete-token admin-request (second tokens)))
        now (latest-op-ts)
        times [made edited now]
        before (answers doc times)]
    (is (= 9 recorded) "a text, four tokens and four spans, recorded as the importers before lazy rows did")
    (run-up-sql!)
    (testing "the untouched rows' insert rows went"
      (is (= 6 (- recorded (count (psc/q db ["SELECT 1 FROM audit_writes WHERE document_id = ? AND seq < 0" (str doc)])))))
      (is (empty? (psc/q db ["SELECT 1 FROM audit_writes WHERE target_id = ?" (str (nth spans 2))]))))
    (testing "every as-of read and restore preview is the same"
      (is (= before (answers doc times))))))
