(ns plaid.history.unrecorded-rows-test
  "A row a document owns with no audit row at all is read live by the as-of
  reads and by restore, as existing since the document was created. An
  import leaves its rows that way (`plaid.sql.audit-write`, \"Lazy rows\"),
  and the one-time removal of old import rows does the same to rows already
  written. Here the rows are written eagerly and their insert rows deleted
  by hand, which is what the removal does, so every answer can be compared
  with the one the full log gave."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    assert-created assert-ok assert-no-content
                                    assert-status with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.history.restore :as restore]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn build-document
  "A document with a row of every kind, metadata on each, and a vocabulary
  link. Returns the ids."
  [proj-name]
  (let [proj (create-test-project admin-request proj-name)
        doc-id (create-test-document admin-request proj "D")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        text-id (-> (create-text admin-request tl doc-id "hello world foo bar") :body :id)
        _ (assert-ok (update-text-metadata admin-request text-id {"src" "x"}))
        tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
        t1 (-> (create-token admin-request tkl text-id 0 5) :body :id)
        t2 (-> (create-token admin-request tkl text-id 6 11 nil {"pos" "NOUN"}) :body :id)
        t3 (-> (create-token admin-request tkl text-id 12 15 2) :body :id)
        t4 (-> (create-token admin-request tkl text-id 16 19) :body :id)
        sl (-> (create-span-layer admin-request tkl "SL") :body :id)
        s1 (-> (create-span admin-request sl [t1 t2] "greeting") :body :id)
        s2 (-> (create-span admin-request sl [t3] 42 {"dc/source" "test"}) :body :id)
        s3 (-> (create-span admin-request sl [t3 t4] "x") :body :id)
        rl (-> (create-relation-layer admin-request sl "RL") :body :id)
        r1 (-> (create-relation admin-request rl s1 s2 "dep" {"k" "v"}) :body :id)
        vid (-> (create-vocab-layer admin-request (str proj-name "-V")) :body :id)
        _ (assert-status 204 (link-vocab-to-project admin-request proj vid))
        item (-> (create-vocab-item admin-request vid "hello" {"gloss" "greeting"}) :body :id)
        l1 (-> (create-vocab-link admin-request item [t1 t2] {"conf" 1}) :body :id)]
    {:proj proj :doc doc-id :text text-id :tokens [t1 t2 t3 t4] :spans [s1 s2 s3]
     :relation r1 :link l1 :span-layer sl :token-layer tkl}))

(defn unrecord-untouched!
  "Delete the insert row of every row of `doc-id` that has no other audit
  row, as the removal does. Returns how many went."
  [doc-id]
  (psc/execute! db ["DELETE FROM audit_writes WHERE rowid IN (
                       SELECT min(rowid) FROM audit_writes
                       WHERE document_id = ? AND target_table IN ('texts','tokens','spans','relations','vocab_links')
                       GROUP BY target_table, target_id
                       HAVING count(*) = 1 AND min(change_type) = 'insert')"
                    (str doc-id)]))

(defn answers
  "Every answer the log gives about `doc-id` at each of `times`."
  [doc-id times]
  (mapv (fn [t]
          {:deep (hread/get-with-layer-data-at db doc-id t)
           ;; in no order: the fold keeps rows in a map
           :rows (some-> (hread/document-rows-at db doc-id t) (update-vals #(if (vector? %) (set %) %)))
           :restore (restore/preview db doc-id t)})
        times))

(deftest rows-with-no-audit-row-read-as-they-are-since-the-document-was-made
  (let [{:keys [doc tokens spans relation link]} (build-document "Unrec")
        [t1 _ _ t4] tokens
        [_ s2 _] spans
        made (latest-op-ts)
        ;; later edits, which leave some rows with only their insert row
        _ (assert-ok (update-span admin-request s2 :value "forty-two"))
        edited (latest-op-ts)
        _ (assert-no-content (delete-token admin-request t4))
        deleted (latest-op-ts)
        _ (assert-ok (update-relation admin-request relation "dep2"))
        now (latest-op-ts)
        times [made edited deleted now]
        before (answers doc times)
        removed (unrecord-untouched! doc)]
    (testing "untouched rows of every kind are left with no audit row"
      (is (= 5 removed))
      (is (empty? (psc/q db ["SELECT 1 FROM audit_writes WHERE target_id IN (?, ?, ?, ?)"
                             (str t1) (str (first spans)) (str link) (str (nth tokens 1))]))))
    (testing "every as-of read and every restore preview is the same as with the full log"
      (is (= before (answers doc times))))
    (testing "the read at now is the live read"
      (is (= (doc/get-with-layer-data db doc) (hread/get-with-layer-data-at db doc now))))
    (testing "before the document existed there is nothing"
      (is (nil? (hread/document-rows-at db doc "2000-01-01T00:00:00Z"))))))

(defn- comparable [deep]
  (dissoc deep :document/version :document/time-modified :document/media-url))

(deftest a-restore-brings-back-the-state-at-t-around-rows-with-no-audit-row
  (let [{:keys [doc spans]} (build-document "UnrecRestore")
        [s1 _ _] spans
        made (latest-op-ts)
        at-made (comparable (doc/get-with-layer-data db doc))
        _ (assert-ok (update-span admin-request s1 :value "changed"))
        _ (unrecord-untouched! doc)
        r (api-call admin-request {:method :post
                                   :path (str "/api/v1/documents/" doc "/restore?as-of="
                                              (java.net.URLEncoder/encode (str made) "UTF-8"))})]
    (assert-ok r)
    (testing "only the edited span changes"
      (is (= 1 (get-in r [:body :total])))
      (is (= 1 (get-in r [:body :spans :updated]))))
    (testing "the document is as it was"
      (is (= at-made (comparable (doc/get-with-layer-data db doc)))))))

;; ------------------------------------------------------------
;; The closed-tagset exemption
;; ------------------------------------------------------------

(defn group-query
  "A query string putting a request in a fresh operation group of `kind`, or
  of no kind."
  [kind]
  (str "?group-id=" (random-uuid) "&group-message=G" (when kind (str "&group-kind=" kind))))

(defn grouped
  "`api-call` with `q` (from `group-query`) on the path."
  [q method path body]
  (api-call admin-request {:method method :path (str path q) :body body}))

(defn grouped-document!
  "A document made the way an importer makes one: created, then filled by
  separate requests, all in the one group of `q`: a text, a token per
  word and a span per token with `values`. Returns the ids."
  [q proj tl tkl sl name values]
  (let [doc (-> (grouped q :post "/api/v1/documents" {:project-id proj :name name}) :body :id)
        words (map #(str "w" %) (range (count values)))
        body (str/join " " words)
        text (-> (grouped q :post "/api/v1/texts" {:text-layer-id tl :document-id doc :body body}) :body :id)
        offsets (reductions (fn [b w] (+ b (count w) 1)) 0 words)
        tokens (-> (grouped q :post "/api/v1/tokens/bulk"
                            (mapv (fn [w b] {:token-layer-id tkl :text text :begin b :end (+ b (count w))})
                                  words offsets))
                   :body :ids)
        spans (-> (grouped q :post "/api/v1/spans/bulk"
                           (mapv (fn [t v] {:span-layer-id sl :tokens [t] :value v}) tokens values))
                  :body :ids)]
    {:doc doc :text text :tokens tokens :spans spans}))

(defn- declare-values! [sl values]
  (api-call admin-request {:method :put :path (str "/api/v1/span-layers/" sl "/constraints/igt")
                           :body {:constraints [{:type "value-set" :values values}]}}))

(deftest a-value-with-no-audit-row-is-exempt-when-an-import-made-its-document
  (let [proj (create-test-project admin-request "Exempt")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
        sl (-> (create-span-layer admin-request tkl "SL") :body :id)
        imported (grouped-document! (group-query "import") proj tl tkl sl "Imported" ["A" "ZZ"])
        planned (grouped-document! (group-query "assistant-plan") proj tl tkl sl "Planned" ["A" "YY"])
        refused (fn []
                  (let [r (declare-values! sl ["A"])]
                    (assert-status 422 r)
                    (set (map :at (-> r :body :violations)))))]
    (testing "only the plan's value is refused"
      (is (= #{(str (second (:spans planned)))} (set (map str (refused))))))
    ;; Both groups made their documents, so their rows were written with no
    ;; audit row. The removal leaves the same shape.
    (unrecord-untouched! (:doc imported))
    (unrecord-untouched! (:doc planned))
    (is (empty? (psc/q db ["SELECT 1 FROM audit_writes WHERE target_id = ?" (str (second (:spans imported)))])))
    (testing "with no audit row, the import's value is still exempt and the plan's is not"
      (is (= #{(str (second (:spans planned)))} (set (map str (refused))))))))
