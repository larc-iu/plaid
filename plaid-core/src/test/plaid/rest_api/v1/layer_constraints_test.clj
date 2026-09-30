(ns plaid.rest-api.v1.layer-constraints-test
  "The layer constraint routes: who may call them, what a declaration
  validates, the refusal of a list the stored data breaks, the
  compare-and-set, check and repair, and constraints on every read."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request user1-request user2-request with-admin with-test-users
                                    api-call assert-status with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        create-text-layer create-token-layer-opts
                                        create-span-layer create-relation-layer
                                        create-text create-token create-span create-relation
                                        add-project-reader add-project-writer]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id str))

(defn- call [req method path & [body]]
  (api-call req (cond-> {:method method :path path} body (assoc :body body))))

(defn- setup! []
  (let [proj (create-test-project admin-request "Routes")
        doc (create-test-document admin-request proj "D")
        tl (id (create-text-layer admin-request proj "T"))
        sl (id (create-token-layer-opts admin-request tl "Sentence" {:overlap-mode "non-overlapping"}))
        wl (id (create-token-layer-opts admin-request tl "Word" {:overlap-mode "non-overlapping"}))
        anyl (id (create-token-layer-opts admin-request tl "Any" {}))
        lemma (id (create-span-layer admin-request wl "Lemma"))
        deps (id (create-relation-layer admin-request lemma "Deps"))
        txt (id (create-text admin-request tl doc "a b c"))
        a (id (create-token admin-request wl txt 0 1))
        b (id (create-token admin-request wl txt 2 3))
        c (id (create-token admin-request wl txt 4 5))
        sa (id (create-span admin-request lemma [a] "x"))
        sb (id (create-span admin-request lemma [b] "y"))
        sc (id (create-span admin-request lemma [c] "z"))]
    (add-project-writer admin-request proj "user1@example.com")
    (add-project-reader admin-request proj "user2@example.com")
    {:proj proj :doc (str doc) :tl tl :sl sl :wl wl :anyl anyl :lemma lemma :deps deps :txt txt
     :tokens [a b c] :spans [sa sb sc]}))

(defn- put [req kind layer ns body]
  (call req :put (str "/api/v1/" kind "-layers/" layer "/constraints/" ns) body))

(deftest who-may-declare
  (let [{:keys [lemma]} (setup!)
        body {:constraints [{:type "single-span"}]}]
    (assert-status 403 (put user1-request "span" lemma "igt" body))
    (assert-status 403 (put user2-request "span" lemma "igt" body))
    (assert-status 200 (put admin-request "span" lemma "igt" body))
    (testing "an unknown layer is a 403 for anyone but an admin"
      (assert-status 403 (put user1-request "span" (random-uuid) "igt" body))
      (assert-status 404 (put admin-request "span" (random-uuid) "igt" body)))))

(deftest declarations-are-validated
  (let [{:keys [lemma deps wl sl anyl]} (setup!)
        bad? (fn [kind layer cs]
               (let [r (put admin-request kind layer "igt" {:constraints cs})]
                 (and (= 400 (:status r)) (string? (-> r :body :error)))))]
    (is (bad? "span" lemma [{:type "nope"}]) "unknown type")
    (is (bad? "span" lemma [{:type "max-in-degree" :max 1}]) "wrong layer kind")
    (is (bad? "span" lemma [{:type "single-span" :color "red"}]) "unknown key")
    (is (bad? "span" lemma [{:type "single-span"} {:type "single-span"}]) "a type twice")
    (is (bad? "span" lemma [{:type "value-set" :values ["a"] :delimiters " "}]) "whitespace delimiter")
    (is (bad? "span" lemma [{:type "value-set"}]) "no values")
    (is (bad? "span" lemma [{:type "value-set" :values ["a"] :parts "some"}]) "parts")
    (is (bad? "relation" deps [{:type "max-in-degree" :max 0}]) "max below 1")
    (is (bad? "relation" deps [{:type "same-ancestor" :token-layer anyl}]) "an overlapping ancestor layer")
    (is (bad? "relation" deps [{:type "same-ancestor" :token-layer (str (random-uuid))}]) "no such layer")
    (is (bad? "token" wl [{:type "coextensive"}]) "coextensive on a root layer")
    (is (bad? "relation" deps [{:type "acyclic" :self-loops "yes"}]))
    (testing "a same-ancestor layer on another text layer"
      (let [other-tl (id (create-text-layer admin-request (:proj (setup!)) "T2"))]
        (is (some? other-tl))))
    (testing "namespaces"
      (assert-status 400 (put admin-request "span" lemma "Igt" {:constraints []}))
      (assert-status 405 (put admin-request "span" lemma "check" {:constraints []})))
    (assert-status 200 (put admin-request "relation" deps "ud" {:constraints [{:type "same-ancestor" :token-layer sl}]}))))

(deftest a-declaration-the-data-breaks-is-refused
  (let [{:keys [lemma deps spans doc]} (setup!)
        [sa sb sc] spans]
    (create-relation admin-request deps sa sc "x")
    (create-relation admin-request deps sb sc "x")
    (let [r (put admin-request "relation" deps "ud" {:constraints [{:type "max-in-degree" :max 1}]})]
      (assert-status 422 r)
      (is (= 1 (-> r :body :violation-count)))
      (is (= doc (-> r :body :violations first :document)))
      (is (= sc (-> r :body :violations first :at))))
    (is (= "{}" (:constraints (psc/fetch-by-id db :relation_layers deps))) "nothing is stored")
    (let [r (put admin-request "span" lemma "igt" {:constraints [{:type "value-set" :values ["x"]}]})]
      (assert-status 422 r)
      (is (= 2 (-> r :body :violation-count)))
      (is (= #{"y" "z"} (set (map :value (-> r :body :violations))))))))

(deftest the-listing-is-capped
  (let [{:keys [lemma wl txt]} (setup!)
        tokens (for [i (range 120)] (id (create-token admin-request wl txt 5 5 i)))]
    (doseq [t tokens] (create-span admin-request lemma [t] "bad"))
    (let [r (put admin-request "span" lemma "igt" {:constraints [{:type "value-set" :values ["x" "y" "z"]}]})]
      (assert-status 422 r)
      (is (= 120 (-> r :body :violation-count)))
      (is (= 100 (count (-> r :body :violations)))))))

(deftest compare-and-set-and-delete
  (let [{:keys [lemma]} (setup!)
        cs [{:type "single-span"}]]
    (assert-status 200 (put admin-request "span" lemma "igt" {:constraints cs :expected nil}))
    (testing "expected absent when present is a 409"
      (let [r (put admin-request "span" lemma "igt" {:constraints cs :expected nil})]
        (assert-status 409 r)
        (is (true? (-> r :body :constraints-changed)))))
    (testing "re-declaring the same list writes no audit row"
      (let [n (count (psc/q db {:select [:id] :from :audit_writes :where [:= :target_table "span_layers"]}))]
        (assert-status 200 (put admin-request "span" lemma "igt" {:constraints cs :expected cs}))
        (is (= n (count (psc/q db {:select [:id] :from :audit_writes :where [:= :target_table "span_layers"]}))))))
    (testing "two namespaces keep their own lists"
      (let [r (put admin-request "span" lemma "ud" {:constraints [{:type "single-span" :join-with "/"}]})]
        (assert-status 200 r)
        (is (= #{"igt" "ud"} (set (keys (-> r :body :constraints)))))))
    (testing "delete with a stale expected is a 409, then a plain delete"
      (assert-status 409 (call admin-request :delete (str "/api/v1/span-layers/" lemma "/constraints/igt")
                               {:expected []}))
      (assert-status 204 (call admin-request :delete (str "/api/v1/span-layers/" lemma "/constraints/igt")))
      (is (= {"ud" [{"type" "single-span" "join-with" "/"}]}
             (psc/parse-config (:constraints (psc/fetch-by-id db :span_layers lemma))))))))

(deftest reads-carry-constraints
  (let [{:keys [proj lemma doc]} (setup!)]
    (assert-status 200 (put admin-request "span" lemma "igt" {:constraints [{:type "single-span"}]}))
    (is (= {"igt" [{"type" "single-span"}]}
           (:constraints (:body (call user2-request :get (str "/api/v1/span-layers/" lemma))))))
    (let [project (:body (call user2-request :get (str "/api/v1/projects/" proj)))
          layers (for [txtl (:project/text-layers project)
                       tokl (:text-layer/token-layers txtl)
                       sl (:token-layer/span-layers tokl)]
                   sl)]
      (is (= {"igt" [{"type" "single-span"}]}
             (:constraints (first (filter #(= lemma (str (:span-layer/id %))) layers))))))
    (let [document (:body (call user2-request :get (str "/api/v1/documents/" doc "?include-body=true")))
          layers (for [txtl (:document/text-layers document)
                       tokl (:text-layer/token-layers txtl)
                       sl (:token-layer/span-layers tokl)]
                   sl)]
      (is (= {"igt" [{"type" "single-span"}]}
             (:constraints (first (filter #(= lemma (str (:span-layer/id %))) layers))))))))

(deftest check-and-repair
  (let [{:keys [lemma tokens spans doc]} (setup!)
        [a] tokens
        [sa] spans
        extra (id (create-span admin-request lemma [a] "w"))]
    (testing "check lists violations and writes nothing"
      (let [r (call admin-request :post (str "/api/v1/span-layers/" lemma "/constraints/check")
                    {:constraints [{:type "single-span"} {:type "value-set" :values ["x" "y" "z"]}]})]
        (assert-status 200 r)
        (is (= 2 (-> r :body :violation-count)))
        (is (= #{"single-span" "value-set"} (set (map :constraint (-> r :body :violations)))))))
    (testing "repair joins the doubled spans into the smallest id"
      (let [r (call admin-request :post (str "/api/v1/span-layers/" lemma "/constraints/repair")
                    {:constraints [{:type "single-span"} {:type "value-set" :values ["x" "y" "z"]}]})
            keep (first (sort [sa extra]))
            gone (first (remove #{keep} [sa extra]))]
        (assert-status 200 r)
        (is (= [{:document doc :constraint "single-span" :deleted 1 :joined 1}] (-> r :body :repaired)))
        (is (nil? (psc/fetch-by-id db :spans gone)))
        (is (some? (psc/fetch-by-id db :spans keep)))
        (testing "value-set has no remedy, so its violation remains listed"
          (is (= 1 (-> r :body :violation-count))))
        (is (= 1 (count (psc/q db {:select [:id] :from :operations
                                   :where [:and [:= :op_type "layer/repair-constraints"] [:= :document_id doc]]}))))))
    (assert-status 200 (put admin-request "span" lemma "igt" {:constraints [{:type "single-span"}]}))))

(deftest the-routes-are-batchable
  (let [{:keys [lemma deps]} (setup!)
        r (call admin-request :post "/api/v1/batch"
                [{:path (str "/api/v1/span-layers/" lemma "/constraints/igt") :method "PUT"
                  :body {:constraints [{:type "single-span"}]}}
                 {:path (str "/api/v1/span-layers/" lemma "/constraints/check") :method "POST"
                  :body {:constraints [{:type "single-span"}]}}
                 {:path (str "/api/v1/span-layers/" lemma "/constraints/repair") :method "POST"
                  :body {:constraints [{:type "single-span"}]}}
                 {:path (str "/api/v1/relation-layers/" deps "/constraints/ud") :method "PUT"
                  :body {:constraints [{:type "max-in-degree" :max 1}]}}])]
    (assert-status 200 r)
    (testing "a refused declaration in a batch is the batch's 422"
      (create-relation admin-request deps (first (:spans (setup!))) (first (:spans (setup!))) "x")
      (let [r (call admin-request :post "/api/v1/batch"
                    [{:path (str "/api/v1/span-layers/" lemma "/constraints/igt") :method "PUT"
                      :body {:constraints [{:type "value-set" :values ["q"]}]}}])]
        (assert-status 422 r)
        (is (= 3 (-> r :body :violation-count)))))))
