(ns plaid.rest-api.v1.audit-op-type-filter-test
  "`?op-types=` on the three audit endpoints (issue #56): return only the
  operations whose `op/type` is in a caller-supplied list, so a client can
  cheaply ask 'has anything I cache changed?' without paging the whole log.

  The filter scopes MEMBERS, exactly as the time window and the entity scope
  already do: an entry surfaces when one of its operations matches, carrying
  only the operations that did. A batch that created a span layer and some
  tokens therefore comes back holding just its layer-create."
  (:require [clojure.test :refer :all]
            [clojure.string :as str]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request admin-token rest-handler with-admin
                                    api-call assert-ok assert-created assert-status with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- op-type-str
  "`:span-layer/create` -> \"span-layer/create\" (`name` would drop the
  namespace, which is half the value)."
  [op]
  (subs (str (:op/type op)) 1))

(defn- op-types-in [body]
  (set (map op-type-str (mapcat :audit/ops (:entries body)))))

(defn- entry-count [body] (count (:entries body)))

(defn- audit! [proj query]
  (let [r (get-project-audit admin-request proj query)]
    (assert-ok r)
    (:body r)))

(deftest filters-to-the-named-op-types
  (let [proj (create-test-project admin-request "OpTypeFilterProj")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
        _ (assert-created (create-span-layer admin-request tkl "POS"))
        doomed (-> (create-span-layer admin-request tkl "Lemma") :body :id)
        _ (assert-status 204 (api-call admin-request {:method :delete
                                                      :path (str "/api/v1/span-layers/" doomed)}))
        _ (create-test-document admin-request proj "Doc")]

    (testing "unfiltered read sees every op type"
      (let [ts (op-types-in (audit! proj {}))]
        (is (contains? ts "span-layer/create"))
        (is (contains? ts "span-layer/delete"))
        (is (contains? ts "document/create"))
        (is (contains? ts "project/create"))))

    (testing "a single type narrows to exactly that type"
      (is (= #{"span-layer/delete"}
             (op-types-in (audit! proj {:op-types ["span-layer/delete"]})))))

    (testing "several types are ORed"
      (is (= #{"span-layer/create" "span-layer/delete"}
             (op-types-in (audit! proj {:op-types ["span-layer/create" "span-layer/delete"]})))))

    (testing "a type with no activity yields an empty page, not an error"
      (let [body (audit! proj {:op-types ["relation/create"]})]
        (is (= 0 (entry-count body)))
        (is (nil? (:next-cursor body)))))

    (testing "whitespace and duplicates are tolerated"
      (is (= (entry-count (audit! proj {:op-types ["span-layer/create"]}))
             (entry-count (audit! proj {:op-types " span-layer/create , span-layer/create "})))))

    (testing "an empty value means no filter at all"
      (is (= (entry-count (audit! proj {}))
             (entry-count (audit! proj {:op-types " "})))))))

(deftest filter-applies-to-members-so-a-batch-shows-only-its-matches
  (let [proj (create-test-project admin-request "OpTypeBatchProj")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
        doc (create-test-document admin-request proj "Doc")
        text (-> (create-text admin-request tl doc "a b c") :body :id)
        ops [{:path "/api/v1/span-layers" :method "post"
              :body {:token-layer-id tkl :name "Batched"}}
             {:path "/api/v1/tokens" :method "post"
              :body {:token-layer-id tkl :text text :begin 0 :end 1}}
             {:path "/api/v1/tokens" :method "post"
              :body {:token-layer-id tkl :text text :begin 2 :end 3}}]
        batch-res (rest-handler (-> (mock/request :post "/api/v1/batch")
                                    (mock/header "accept" "application/edn")
                                    (mock/json-body ops)
                                    (mock/header "authorization" (str "Bearer " admin-token))))]
    (is (= 200 (:status batch-res)))

    (let [unfiltered (audit! proj {})
          batch-entry (first (filter :audit/batch-id (:entries unfiltered)))]
      (is (some? batch-entry) "the batch folded into one entry")
      (is (= 3 (count (:audit/ops batch-entry))) "carrying all three members"))

    (testing "filtering keeps the batch entry but drops its non-matching members"
      (let [body (audit! proj {:op-types ["span-layer/create"]})
            batch-entry (first (filter :audit/batch-id (:entries body)))]
        (is (some? batch-entry) "the batch still surfaces, since one member matched")
        (is (= ["span-layer/create"] (mapv op-type-str (:audit/ops batch-entry)))
            "and carries only the member that matched")))))

(deftest a-malformed-op-type-is-a-400
  (let [proj (create-test-project admin-request "OpTypeBadProj")]
    (testing "the SSE spelling of the same op is rejected, not silently empty"
      ;; The /listen stream spells this operation `span_layer:create`; pasting
      ;; that here must say so rather than look like 'nothing ever happened'.
      (let [r (get-project-audit admin-request proj {:op-types ["span_layer:create"]})]
        (assert-status 400 r)
        (is (str/includes? (-> r :body :error) "span_layer:create"))
        (is (str/includes? (-> r :body :error) "entity/verb"))))

    (testing "one bad entry in an otherwise valid list still 400s"
      (assert-status 400 (get-project-audit admin-request proj
                                            {:op-types ["span-layer/create" "NotAnOpType"]})))))

(deftest filter-works-on-the-document-and-user-endpoints-too
  (let [proj (create-test-project admin-request "OpTypeScopeProj")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        doc (create-test-document admin-request proj "Doc")
        _ (assert-created (create-text admin-request tl doc "hello"))]

    (testing "document audit"
      (let [r (get-document-audit admin-request doc {:op-types ["text/create"]})]
        (assert-ok r)
        (is (= #{"text/create"} (op-types-in (:body r))))))

    (testing "user audit"
      (let [r (get-user-audit admin-request "admin@example.com" {:op-types ["text/create"]})]
        (assert-ok r)
        (is (= #{"text/create"} (op-types-in (:body r))))
        (is (pos? (entry-count (:body r))))))))
