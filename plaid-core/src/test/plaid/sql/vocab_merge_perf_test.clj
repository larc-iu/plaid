(ns plaid.sql.vocab-merge-perf-test
  "A merge of lexicon entries rewrites the metadata that names a merged
  entry (`plaid.sql.vocab-item/repoint-metadata-refs!`), inside the write
  transaction. Its cost must follow the vocabulary's own projects, not the
  server: here an unrelated project holds 600,000 token metadata rows, and
  a merge of 1,000 entries of a small vocabulary must stay well under a
  second of write lock. Read from the metadata side, one row at a time per
  200 entries, it took 15 s on such a server and 79 s on prod's."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call assert-status with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-test-document create-text-layer
                                        create-token-layer-opts create-text create-vocab-layer
                                        create-vocab-item link-vocab-to-project]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(def ^:private n-bystanders 200000)
(def ^:private n-losers 1000)
(def ^:private limit-ms
  "It takes about 0.16 s here. Read from the metadata side it took 19 s."
  2000)

(defn- id [resp] (-> resp :body :id))

(defn- insert! [table rows]
  (doseq [chunk (partition-all 4000 rows)]
    (psc/execute! db {:insert-into table :values (vec chunk)})))

(defn- document-with-tokens!
  "A document of `n` tokens, put in with plain inserts. Answers its token ids."
  [proj n]
  (let [doc (create-test-document admin-request proj "D")
        tl (id (create-text-layer admin-request proj "T"))
        wl (id (create-token-layer-opts admin-request tl "W" {:overlap-mode "any"}))
        txt (id (create-text admin-request tl doc "abcdefghij"))
        rows (mapv (fn [_] {:id (str (psc/new-uuid)) :text_id (str txt) :token_layer_id (str wl)
                            :document_id (str doc) :begin 0 :end_ 1})
                   (range n))]
    (insert! :tokens rows)
    (mapv :id rows)))

(deftest a-merge-of-many-entries-costs-what-its-vocabulary-holds
  (let [;; The server's other work: 600,000 metadata rows, each with an id in it.
        other (create-test-project admin-request "Elsewhere")
        bystanders (document-with-tokens! other n-bystanders)
        _ (insert! :entity_metadata
                   (for [t bystanders
                         [k v] [["form" "\"abc\""]
                                ["ref" (psc/write-json {"entry" (str (psc/new-uuid))})]
                                ["prov" "{\"by\":\"someone\"}"]]]
                     {:entity_type "token" :entity_id t :key k :value v}))
        ;; The vocabulary, linked to a small project, and one pointer in it.
        proj (create-test-project admin-request "Small")
        vocab (id (create-vocab-layer admin-request "Lex"))
        _ (link-vocab-to-project admin-request proj vocab)
        [tok] (document-with-tokens! proj 1)
        survivor (id (create-vocab-item admin-request vocab "s"))
        losers (mapv (fn [_] (str (psc/new-uuid))) (range n-losers))
        _ (insert! :vocab_items (for [l losers] {:id l :vocab_layer_id (str vocab) :form "l"}))
        _ (insert! :entity_metadata [{:entity_type "token" :entity_id tok :key "app"
                                      :value (psc/write-json {"entry" (last losers)})}])
        t0 (System/nanoTime)
        resp (api-call admin-request {:method :post
                                      :path (str "/api/v1/vocab-items/" survivor "/merge")
                                      :body {:losers losers}})
        ms (/ (- (System/nanoTime) t0) 1e6)]
    (assert-status 200 resp)
    (testing "the pointer follows the merge"
      (is (= (psc/write-json {"entry" (str survivor)})
             (:value (psc/q1 db {:select [:value] :from :entity_metadata
                                 :where [:and [:= :entity_type "token"] [:= :entity_id tok]
                                         [:= :key "app"]]})))))
    (testing "the merge does not read the rest of the server"
      (is (< ms limit-ms) (str "the merge took " ms " ms")))))
