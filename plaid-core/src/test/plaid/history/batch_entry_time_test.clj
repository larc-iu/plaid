(ns plaid.history.batch-entry-time-test
  "A history entry's end time names the state AFTER the entry, also when the
  entry's last write sat inside an atomic batch that went on to write
  something else (another document, a vocabulary entry). The history rail
  selects that time and the restore dialog restores to it, so a restore there
  must change nothing."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    assert-created assert-ok with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.sql.document :as doc]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- restore-dry-run [doc-id ts]
  (api-call admin-request {:method :post
                           :path (str "/api/v1/documents/" doc-id "/restore?dry-run=true&as-of="
                                      (java.net.URLEncoder/encode (str ts) "UTF-8"))}))

(defn- span-values [deep]
  (vec (for [tl (:document/text-layers deep)
             tkl (:text-layer/token-layers tl)
             sl (:token-layer/span-layers tkl)
             s (:span-layer/spans sl)]
         (:span/value s))))

(defn- setup! []
  (let [proj (create-test-project admin-request "Batch entry time")
        doc-a (create-test-document admin-request proj "A")
        doc-b (create-test-document admin-request proj "B")
        tl (-> (create-text-layer admin-request proj "Text") :body :id)
        word (-> (create-token-layer admin-request tl "Words") :body :id)
        pos (-> (create-span-layer admin-request word "POS") :body :id)
        text-a (-> (create-text admin-request tl doc-a "kai tat") :body :id)
        text-b (-> (create-text admin-request tl doc-b "zz") :body :id)
        tok (-> (create-token admin-request word text-a 0 3) :body :id)
        span (-> (create-span admin-request pos [tok] "before") :body :id)]
    {:proj proj :doc-a doc-a :word word :text-b text-b :span span}))

(defn- last-entry [doc-id]
  (let [resp (get-document-audit admin-request doc-id)]
    (assert-ok resp)
    (last (-> resp :body :entries))))

(defn- check-entry-lands-after! [doc-a]
  (let [entry (last-entry doc-a)
        end (:audit/end-time entry)
        live (doc/get-with-layer-data db doc-a)]
    (is (= ["after"] (span-values live)))
    (testing "the document read at the entry's end time shows the entry's change"
      (is (= ["after"] (span-values (hread/get-with-layer-data-at db doc-a end)))))
    (testing "a restore to the entry's end time changes nothing"
      (let [resp (restore-dry-run doc-a end)]
        (assert-ok resp)
        (is (zero? (-> resp :body :total)) (pr-str (:body resp)))))))

(deftest batch-ending-on-another-document
  (let [{:keys [doc-a word text-b span]} (setup!)
        resp (api-call admin-request
                       {:method :post :path "/api/v1/batch"
                        :body [{:path (str "/api/v1/spans/" span) :method "patch" :body {:value "after"}}
                               {:path "/api/v1/tokens" :method "post"
                                :body {:token-layer-id word :text text-b :begin 0 :end 1}}]})]
    (assert-ok resp)
    (is (every? #(< (:status %) 300) (:body resp)))
    (check-entry-lands-after! doc-a)))

(deftest batch-ending-on-a-vocabulary-entry
  (let [{:keys [proj doc-a span]} (setup!)
        vocab (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        _ (link-vocab-to-project admin-request proj vocab)
        resp (api-call admin-request
                       {:method :post :path "/api/v1/batch"
                        :body [{:path (str "/api/v1/spans/" span) :method "patch" :body {:value "after"}}
                               {:path "/api/v1/vocab-items" :method "post"
                                :body {:vocab-layer-id vocab :form "kai"}}]})]
    (assert-ok resp)
    (is (every? #(< (:status %) 300) (:body resp)))
    (check-entry-lands-after! doc-a)))

(deftest a-time-inside-a-batch-still-reads-before-it
  ;; The clamp itself stays: a time strictly inside a batch was never a
  ;; committed state, so the read goes back to before the batch.
  (let [{:keys [doc-a word text-b span]} (setup!)
        _ (assert-ok (api-call admin-request
                               {:method :post :path "/api/v1/batch"
                                :body [{:path (str "/api/v1/spans/" span) :method "patch" :body {:value "after"}}
                                       {:path "/api/v1/tokens" :method "post"
                                        :body {:token-layer-id word :text text-b :begin 0 :end 1}}]}))
        entry (last-entry doc-a)
        op-time (-> entry :audit/ops last :op/time)]
    (is (= ["before"] (span-values (hread/get-with-layer-data-at db doc-a op-time))))))

(deftest an-op-inside-a-batch-ends-with-its-batch
  ;; The history rail lets a reader pick one op of an entry. An op in a
  ;; batch carries the batch's end time, so reading or restoring there shows
  ;; the whole batch done rather than the state before it.
  (let [{:keys [proj doc-a word text-b span]} (setup!)
        _ (assert-ok (api-call admin-request
                               {:method :post :path "/api/v1/batch"
                                :body [{:path (str "/api/v1/spans/" span) :method "patch" :body {:value "after"}}
                                       {:path "/api/v1/tokens" :method "post"
                                        :body {:token-layer-id word :text text-b :begin 0 :end 1}}]}))
        entry (last-entry doc-a)
        op (-> entry :audit/ops last)]
    (is (= 1 (count (:audit/ops entry))) "the document's entry holds its own op only")
    (is (= (:audit/end-time entry) (:op/end-time op)))
    (is (neg? (compare (:op/time op) (:op/end-time op))))
    (is (= ["after"] (span-values (hread/get-with-layer-data-at db doc-a (:op/end-time op)))))
    (let [resp (restore-dry-run doc-a (:op/end-time op))]
      (assert-ok resp)
      (is (zero? (-> resp :body :total)) (pr-str (:body resp))))
    (testing "the project's entry gives each op the same batch end"
      (let [pentry (last (-> (get-project-audit admin-request proj) :body :entries))]
        (is (= 2 (count (:audit/ops pentry))))
        (is (apply = (:audit/end-time pentry) (map :op/end-time (:audit/ops pentry))))))))

(deftest an-op-in-a-group-of-batches-ends-with-its-own-batch
  (let [{:keys [doc-a word text-b span]} (setup!)
        group (str (random-uuid))
        batch! (fn [value]
                 (assert-ok (api-call admin-request
                                      {:method :post :path (str "/api/v1/batch?group-id=" group)
                                       :body [{:path (str "/api/v1/spans/" span) :method "patch" :body {:value value}}
                                              {:path "/api/v1/tokens" :method "post"
                                               :body {:token-layer-id word :text text-b :begin 0 :end 1}}]})))
        _ (batch! "middle")
        _ (batch! "after")
        entry (last-entry doc-a)
        [first-op second-op] (:audit/ops entry)]
    (is (= 2 (count (:audit/ops entry))))
    (is (neg? (compare (:op/end-time first-op) (:op/time second-op))))
    (is (= (:audit/end-time entry) (:op/end-time second-op)))
    (is (= ["middle"] (span-values (hread/get-with-layer-data-at db doc-a (:op/end-time first-op)))))
    (is (= ["after"] (span-values (hread/get-with-layer-data-at db doc-a (:op/end-time second-op)))))))

(deftest a-lone-write-ends-at-its-own-time
  (let [{:keys [doc-a span]} (setup!)]
    (assert-ok (update-span admin-request span :value "after"))
    (let [entry (last-entry doc-a)]
      (is (= (:audit/time entry) (:audit/end-time entry)))
      (is (= (:audit/time entry) (-> entry :audit/ops first :op/end-time)))
      (check-entry-lands-after! doc-a))))
