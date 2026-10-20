(ns plaid.sql.audit-first-touch-test
  "A row with no audit row is recorded whole before its first change
  (`plaid.sql.audit-write/ensure-recorded!`), under the operation that
  created its document, and the recorders refuse a change whose row the
  hook did not see. Each write path that changes or deletes such a row,
  its token list or its metadata is driven here against a document whose
  untouched rows have had their insert rows removed, and the state at the
  time the document was made must read the same afterwards."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    assert-ok assert-no-content assert-status with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.history.unrecorded-rows-test :as unrec]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :refer [submit-operation!]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- backfilled
  "The rows written whole by the hook: negative seqs."
  [doc-id]
  (psc/q db ["SELECT target_table, target_id, op_id FROM audit_writes WHERE document_id = ? AND seq < 0"
             (str doc-id)]))

(defn- creating-op [doc-id]
  (:op_id (psc/q1 db ["SELECT op_id FROM audit_writes WHERE target_table = 'documents'
                       AND target_id = ? AND change_type = 'insert'" (str doc-id)])))

(defn- unordered
  "`document-rows-at` with each list of rows as a set: the fold keeps them
  in a map, so their order says nothing."
  [rows]
  (some-> rows (update-vals #(if (vector? %) (set %) %))))

(defn- check-touch
  "Build a document, remove its untouched rows' insert rows, run `touch!`
  on the ids, and check the state at the document's making is unchanged."
  [label touch!]
  (testing label
    (let [ids (unrec/build-document (str "Touch " label))
          doc (:doc ids)
          made (latest-op-ts)
          deep (hread/get-with-layer-data-at db doc made)
          rows (unordered (hread/document-rows-at db doc made))]
      (unrec/unrecord-untouched! doc)
      (touch! ids)
      (is (seq (backfilled doc)) "the touched rows were recorded whole")
      (is (every? #(= (creating-op doc) (:op_id %)) (backfilled doc))
          "under the operation that created the document")
      (is (= rows (unordered (hread/document-rows-at db doc made))))
      (is (= deep (hread/get-with-layer-data-at db doc made))))))

(defn- call [method path & [body]]
  (api-call admin-request (cond-> {:method method :path path} body (assoc :body body))))

(deftest the-first-change-of-an-unrecorded-row-records-it-whole-first
  (check-touch "span value"
               (fn [{:keys [spans]}] (assert-ok (update-span admin-request (first spans) :value "v2"))))
  (check-touch "span delete"
               (fn [{:keys [spans]}] (assert-no-content (delete-span admin-request (first spans)))))
  (check-touch "span tokens"
               (fn [{:keys [spans tokens]}]
                 (assert-ok (update-span-tokens admin-request (first spans) [(first tokens)]))))
  (check-touch "token delete with span and link trims"
               (fn [{:keys [tokens]}] (assert-no-content (delete-token admin-request (second tokens)))))
  (check-touch "token merge"
               (fn [{:keys [tokens]}] (assert-ok (merge-tokens admin-request (first tokens) (second tokens)))))
  (check-touch "token split"
               (fn [{:keys [tokens]}] (assert-status 201 (split-token admin-request (first tokens) 2))))
  (check-touch "token metadata patch"
               (fn [{:keys [tokens]}]
                 (assert-ok (patch-token-metadata admin-request (first tokens)
                                                  [{:op "set" :path ["a"] :value 1}]))))
  (check-touch "span metadata replace"
               (fn [{:keys [spans]}] (assert-ok (update-span-metadata admin-request (first spans) {"x" "y"}))))
  (check-touch "relation metadata delete"
               (fn [{:keys [relation]}] (assert-ok (delete-relation-metadata admin-request relation))))
  (check-touch "link metadata replace"
               (fn [{:keys [link]}]
                 (assert-ok (call :put (str "/api/v1/vocab-links/" link "/metadata") {"conf" 2}))))
  (check-touch "bulk span update"
               (fn [{:keys [spans]}]
                 (assert-ok (bulk-update-spans admin-request [{:id (first spans) :value "b"}]))))
  (check-touch "text save that shifts every token"
               (fn [{:keys [text]}] (assert-ok (update-text admin-request text "XX hello world foo bar"))))
  (check-touch "text delete"
               (fn [{:keys [text]}] (assert-no-content (delete-text admin-request text))))
  (check-touch "span layer delete"
               (fn [{:keys [span-layer]}] (assert-no-content (call :delete (str "/api/v1/span-layers/" span-layer)))))
  (check-touch "token layer delete"
               (fn [{:keys [token-layer]}] (assert-no-content (call :delete (str "/api/v1/token-layers/" token-layer)))))
  (check-touch "document delete"
               (fn [{:keys [doc]}] (assert-no-content (call :delete (str "/api/v1/documents/" doc)))))
  (check-touch "entry merge moving a link"
               (fn [{:keys [link]}]
                 (let [item (:vocab_item_id (psc/fetch-by-id db :vocab_links link))
                       vocab (:vocab_layer_id (psc/fetch-by-id db :vocab_items item))
                       winner (-> (create-vocab-item admin-request vocab "hi") :body :id)]
                   (assert-ok (call :post (str "/api/v1/vocab-items/" winner "/merge") {:losers [item]})))))
  (check-touch "restore"
               (fn [{:keys [doc spans]}]
                 (let [t (latest-op-ts)]
                   (assert-ok (update-span admin-request (first spans) :value "later"))
                   (assert-no-content (delete-span admin-request (second spans)))
                   (assert-ok (call :post (str "/api/v1/documents/" doc "/restore?as-of="
                                               (java.net.URLEncoder/encode (str t) "UTF-8"))))))))

(deftest a-change-the-hook-did-not-see-is-refused
  (let [{:keys [doc spans]} (unrec/build-document "Guard")
        span (psc/fetch-by-id db :spans (first spans))
        attempt (fn [change]
                  (submit-operation! [tx db {:type :span/update-attributes :document doc
                                             :description "raw" :user "admin@example.com"}]
                                     (psaw/record-audit-write! tx :spans (:id span) change span
                                                               (when (= :update change) span))))]
    (testing "an update or a delete of a document row without the hook rolls back with a 500"
      (is (= 500 (:code (attempt :update))))
      (is (= 500 (:code (attempt :delete)))))
    (testing "with the hook it is taken"
      (is (:success (submit-operation! [tx db {:type :span/update-attributes :document doc
                                               :description "raw" :user "admin@example.com"}]
                                       (psaw/ensure-recorded! tx :spans [(:id span)])
                                       (psaw/record-audit-write! tx :spans (:id span) :update span span)))))))

(deftest a-row-is-recorded-whole-once
  (let [{:keys [doc text spans]} (unrec/build-document "Once")
        s1 (str (first spans))]
    (unrec/unrecord-untouched! doc)
    (assert-ok (update-span admin-request (first spans) :value "a"))
    (assert-ok (update-span admin-request (first spans) :value "b"))
    (assert-ok (patch-span-metadata admin-request (first spans) [{:op "set" :path ["k"] :value 1}]))
    (is (= [s1] (map (comp str :target_id) (backfilled doc))))
    (testing "a row that kept its insert row is not recorded again"
      (assert-ok (update-text-metadata admin-request text {"src" "y"}))
      (is (= [s1] (map (comp str :target_id) (backfilled doc)))))))
