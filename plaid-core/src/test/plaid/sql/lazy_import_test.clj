(ns plaid.sql.lazy-import-test
  "The rows an import makes in a document it created get no audit row
  (`plaid.sql.audit-write`, \"Lazy rows\"). History, as-of reads, restore and
  the closed-tagset exemption read them as made when the document was."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    assert-ok assert-no-content assert-status with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.history.unrecorded-rows-test :as unrec]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- layers [name]
  (let [proj (create-test-project admin-request name)
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
        sl (-> (create-span-layer admin-request tkl "SL") :body :id)]
    {:proj proj :tl tl :tkl tkl :sl sl}))

(defn- import! [{:keys [proj tl tkl sl]} q name values]
  (unrec/grouped-document! q proj tl tkl sl name values))

(defn- row-counts
  "Audit rows of `doc-id` by table."
  [doc-id]
  (into {} (map (juxt :target_table :n))
        (psc/q db ["SELECT target_table, count(*) AS n FROM audit_writes WHERE document_id = ? GROUP BY 1"
                   (str doc-id)])))

(def ^:private document-tables #{"texts" "tokens" "spans" "relations" "vocab_links"})

(defn- entity-rows [doc-id]
  (reduce + 0 (vals (select-keys (row-counts doc-id) document-tables))))

(defn- comparable [deep]
  (dissoc deep :document/version :document/time-modified :document/media-url))

(deftest an-import-records-no-row-of-the-document-it-made
  (let [ls (layers "Lazy")
        {:keys [doc spans tokens]} (import! ls (unrec/group-query "import") "Imported" ["A" "B" "C"])
        imported (latest-op-ts)
        at-import (doc/get-with-layer-data db doc)]
    (testing "only the documents row and the version bumps are recorded"
      (is (= 0 (entity-rows doc)))
      (is (pos? (get (row-counts doc) "documents"))))
    (testing "History lists the import's operations"
      (let [r (get-document-audit admin-request doc {})]
        (assert-ok r)
        ;; the document, its text, its tokens and its spans: four requests
        (is (= 4 (count (mapcat :audit/ops (-> r :body :entries)))))))
    (testing "the read at the end of the import is the live read"
      (is (= at-import (hread/get-with-layer-data-at db doc imported))))
    (assert-ok (update-span admin-request (first spans) :value "AA"))
    (let [edited (latest-op-ts)
          at-edit (doc/get-with-layer-data db doc)]
      (assert-no-content (delete-token admin-request (second tokens)))
      (testing "a change records the rows it changes whole first, and only those"
        ;; the edited span (whole, then its update), the token and the span
        ;; on it alone (whole, then the delete)
        (is (= {"spans" 4 "tokens" 2} (select-keys (row-counts doc) document-tables))))
      (testing "every past state reads as it was"
        (is (= at-import (hread/get-with-layer-data-at db doc imported)))
        (is (= at-edit (hread/get-with-layer-data-at db doc edited)))
        (is (= (doc/get-with-layer-data db doc) (hread/get-with-layer-data-at db doc (latest-op-ts)))))
      (testing "a restore to the end of the import brings it back"
        (assert-ok (api-call admin-request {:method :post
                                            :path (str "/api/v1/documents/" doc "/restore?as-of="
                                                       (java.net.URLEncoder/encode (str imported) "UTF-8"))}))
        (is (= (comparable at-import) (comparable (doc/get-with-layer-data db doc))))))))

(deftest any-group-that-made-the-document-writes-it-unrecorded
  (let [ls (layers "AnyGroup")]
    (testing "an assistant plan's new document"
      (is (= 0 (entity-rows (:doc (import! ls (unrec/group-query "assistant-plan") "Plan" ["A"]))))))
    (testing "a group of no kind (the imports before kinds)"
      (is (= 0 (entity-rows (:doc (import! ls (unrec/group-query nil) "NoKind" ["A"]))))))))

(deftest a-document-someone-else-wrote-is-recorded-row-by-row
  (let [{:keys [proj tl tkl sl]} (layers "Eager")]
    (testing "rows made without a group in a document an earlier request made"
      (let [doc (create-test-document admin-request proj "Plain")
            text (-> (create-text admin-request tl doc "a b") :body :id)]
        (assert-status 201 (create-token admin-request tkl text 0 1))
        (is (= 2 (entity-rows doc)))))
    (testing "an import into a document it did not make"
      (let [doc (create-test-document admin-request proj "Existing")
            q (unrec/group-query "import")
            text (-> (unrec/grouped q :post "/api/v1/texts" {:text-layer-id tl :document-id doc :body "a b"}) :body :id)]
        (assert-status 201 (unrec/grouped q :post "/api/v1/tokens" {:token-layer-id tkl :text text :begin 0 :end 1}))
        (is (= 2 (entity-rows doc)))))
    (testing "the import's rows after someone else wrote its document"
      (let [q (unrec/group-query "import")
            {:keys [doc text tokens]} (unrec/grouped-document! q proj tl tkl sl "Interrupted" ["A"])
            before (entity-rows doc)]
        (is (= 0 before))
        (assert-ok (update-span-metadata admin-request (-> (psc/q1 db ["SELECT id FROM spans WHERE document_id = ?" (str doc)]) :id) {"k" 1}))
        (assert-status 201 (unrec/grouped q :post "/api/v1/tokens" {:token-layer-id tkl :text text :begin 0 :end 1}))
        (is (= 1 (get (row-counts doc) "tokens")) "the late token is recorded, the first is not")
        (is (some? tokens))))))

(deftest an-import-that-changes-its-own-rows-records-them-first
  (let [{:keys [proj tl tkl sl]} (layers "OwnFix")
        q (unrec/group-query "import")
        {:keys [doc spans]} (unrec/grouped-document! q proj tl tkl sl "Own" ["A" "B"])]
    (assert-ok (unrec/grouped q :patch (str "/api/v1/spans/" (first spans)) {:value "AA"}))
    (is (= 2 (get (row-counts doc) "spans")) "the insert, written whole first, then the update")
    (is (= (doc/get-with-layer-data db doc) (hread/get-with-layer-data-at db doc (latest-op-ts))))))

(deftest a-copy-writes-its-rows-unrecorded
  (let [{:keys [doc spans]} (unrec/build-document "Copy")
        r (api-call admin-request {:method :post :path (str "/api/v1/documents/" doc "/copy") :body {:name "D2"}})
        copy (-> r :body :id)
        copied (latest-op-ts)
        at-copy (doc/get-with-layer-data db copy)
        span (:id (psc/q1 db ["SELECT id FROM spans WHERE document_id = ? AND value = ?" (str copy) "\"greeting\""]))]
    (assert-status 201 r)
    (is (= 0 (entity-rows copy)))
    (is (some? span))
    (assert-ok (update-span admin-request span :value "changed"))
    (is (= at-copy (hread/get-with-layer-data-at db copy copied)))
    (is (some? spans))))

(deftest the-exemption-holds-for-an-import-and-not-for-a-plan
  (let [{:keys [proj tl tkl sl]} (layers "LazyExempt")
        imported (unrec/grouped-document! (unrec/group-query "import") proj tl tkl sl "I" ["A" "ZZ"])
        planned (unrec/grouped-document! (unrec/group-query "assistant-plan") proj tl tkl sl "P" ["A" "YY"])]
    (is (= 0 (entity-rows (:doc imported))))
    (let [r (api-call admin-request {:method :put :path (str "/api/v1/span-layers/" sl "/constraints/igt")
                                     :body {:constraints [{:type "value-set" :values ["A"]}]}})]
      (assert-status 422 r)
      (is (= #{(str (second (:spans planned)))} (set (map (comp str :at) (-> r :body :violations))))))
    (testing "with the list declared, an import still stores an unlisted value in a document it makes"
      (assert-ok (api-call admin-request {:method :put :path (str "/api/v1/span-layers/" sl "/constraints/igt")
                                          :body {:constraints [{:type "value-set" :values ["A" "YY"]}]}}))
      (let [{:keys [doc]} (unrec/grouped-document! (unrec/group-query "import") proj tl tkl sl "I2" ["QQ"])]
        (is (some? doc))
        (is (= 0 (entity-rows doc))))
      (let [q (unrec/group-query "assistant-plan")
            doc (-> (unrec/grouped q :post "/api/v1/documents" {:project-id proj :name "P3"}) :body :id)
            text (-> (unrec/grouped q :post "/api/v1/texts" {:text-layer-id tl :document-id doc :body "w"}) :body :id)
            tok (-> (unrec/grouped q :post "/api/v1/tokens" {:token-layer-id tkl :text text :begin 0 :end 1}) :body :id)]
        (testing "and a plan does not"
          (assert-status 422 (unrec/grouped q :post "/api/v1/spans" {:span-layer-id sl :tokens [tok] :value "QQ"})))))))
