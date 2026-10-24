(ns plaid.rest-api.v1.bulk-cross-project-test
  "A bulk route's gate judges the project of the first entry that resolves
  (`pra/bulk-resolver`). That is sound only because the write behind every
  bulk route refuses a list reaching a second document or project. Each route
  and verb here gets a list whose first entry is in project A, which the
  caller writes, and whose second is in project B, which they cannot touch:
  the request is refused and B is left as it was (C1-7)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db
                                    admin-request user1-request api-call assert-status]]
            [plaid.test-helpers :refer [create-test-project create-test-document create-text-layer
                                        create-token-layer create-span-layer create-relation-layer
                                        create-text create-token create-span create-relation
                                        create-vocab-layer create-vocab-item create-vocab-link
                                        add-project-writer add-vocab-maintainer]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- world
  "A project the admin owns, with a layer of each kind, a text \"alpha beta\",
  two tokens, two spans, a relation, and a vocabulary linked to it with an
  entry and a link."
  [label]
  (let [project (create-test-project admin-request label)
        document (create-test-document admin-request project "Doc")
        text-layer (id (create-text-layer admin-request project "TL"))
        token-layer (id (create-token-layer admin-request text-layer "Words"))
        span-layer (id (create-span-layer admin-request token-layer "Spans"))
        relation-layer (id (create-relation-layer admin-request span-layer "Rels"))
        text (id (create-text admin-request text-layer document "alpha beta"))
        t1 (id (create-token admin-request token-layer text 0 5))
        t2 (id (create-token admin-request token-layer text 6 10))
        s1 (id (create-span admin-request span-layer [t1] "a"))
        s2 (id (create-span admin-request span-layer [t2] "b"))
        relation (id (create-relation admin-request relation-layer s1 s2 "r"))
        vocab (id (create-vocab-layer admin-request (str label " vocab")))
        _ (assert-status 204 (api-call admin-request {:method :post
                                                      :path (str "/api/v1/projects/" project "/vocabs/" vocab)}))
        item (id (create-vocab-item admin-request vocab "alpha"))
        link (id (create-vocab-link admin-request item [t1]))]
    {:project project :document document :token-layer token-layer :span-layer span-layer
     :relation-layer relation-layer :text text :t1 t1 :t2 t2 :s1 s1 :s2 s2
     :relation relation :vocab vocab :item item :link link}))

(defn- snapshot
  "Everything project `w` holds that a bulk write could change: its document
  read whole, and its vocabulary with its entries."
  [w]
  [(:body (api-call admin-request {:method :get :path (str "/api/v1/documents/" (:document w) "?include-body=true")}))
   (:body (api-call admin-request {:method :get :path (str "/api/v1/vocab-layers/" (:vocab w) "?include-items=true")}))])

(defn- bulk-cases
  "[label method path body] for every bulk route and verb, the first entry in
  `a` and the second in `b`."
  [a b]
  (let [md (fn [v] [{:op "set" :path ["probe"] :value v}])]
    [["tokens create" :post "/api/v1/tokens/bulk"
      [{:token-layer-id (:token-layer a) :text (:text a) :begin 0 :end 2}
       {:token-layer-id (:token-layer b) :text (:text b) :begin 0 :end 2}]]
     ["tokens update" :patch "/api/v1/tokens/bulk"
      [{:id (:t1 a) :metadata (md "a")} {:id (:t1 b) :metadata (md "b")}]]
     ["tokens delete" :delete "/api/v1/tokens/bulk" [(:t2 a) (:t2 b)]]
     ["spans create" :post "/api/v1/spans/bulk"
      [{:span-layer-id (:span-layer a) :tokens [(:t1 a)] :value "x"}
       {:span-layer-id (:span-layer b) :tokens [(:t1 b)] :value "x"}]]
     ["spans update" :patch "/api/v1/spans/bulk"
      [{:id (:s1 a) :value "changed"} {:id (:s1 b) :value "changed"}]]
     ["spans delete" :delete "/api/v1/spans/bulk" [(:s1 a) (:s1 b)]]
     ["relations create" :post "/api/v1/relations/bulk"
      [{:relation-layer-id (:relation-layer a) :source (:s2 a) :target (:s1 a) :value "x"}
       {:relation-layer-id (:relation-layer b) :source (:s2 b) :target (:s1 b) :value "x"}]]
     ["relations update" :patch "/api/v1/relations/bulk"
      [{:id (:relation a) :value "changed"} {:id (:relation b) :value "changed"}]]
     ["relations delete" :delete "/api/v1/relations/bulk" [(:relation a) (:relation b)]]
     ;; A's own vocabulary, shared with B, on B's token: only the project
     ;; check stops it.
     ["vocab links create, A's entry on B's token" :post "/api/v1/vocab-links/bulk"
      [{:vocab-item (:item a) :tokens [(:t2 a)]} {:vocab-item (:item a) :tokens [(:t2 b)]}]]
     ["vocab links create, B's entry on B's token" :post "/api/v1/vocab-links/bulk"
      [{:vocab-item (:item a) :tokens [(:t2 a)]} {:vocab-item (:item b) :tokens [(:t2 b)]}]]
     ["vocab links delete" :delete "/api/v1/vocab-links/bulk" [(:link a) (:link b)]]
     ["vocab links delete, a shared entry's link in B" :delete "/api/v1/vocab-links/bulk"
      [(:link a) (:shared-link b)]]
     ["vocab items create" :post "/api/v1/vocab-items/bulk"
      [{:vocab-layer-id (:vocab a) :form "new"} {:vocab-layer-id (:vocab b) :form "new"}]]
     ["vocab items update" :patch "/api/v1/vocab-items/bulk"
      [{:id (:item a) :metadata (md "a")} {:id (:item b) :metadata (md "b")}]]
     ["vocab items delete" :delete "/api/v1/vocab-items/bulk" [(:item a) (:item b)]]]))

(deftest a-bulk-list-reaching-a-second-project-is-refused-whole
  (doseq [[label method path body] (bulk-cases {} {})]
    (testing label
      (let [a (world "A")
            b (world "B")
            _ (assert-status 204 (add-project-writer admin-request (:project a) "user1@example.com"))
            ;; A's vocabulary is shared with B too, so a link from A's entry to
            ;; B's token is stopped by the project check alone.
            _ (assert-status 204 (api-call admin-request {:method :post
                                                          :path (str "/api/v1/projects/" (:project b) "/vocabs/" (:vocab a))}))
            ;; So a delete or a rename of A's entries passes A's own gate too.
            _ (is (<= 200 (:status (add-vocab-maintainer admin-request (:vocab a) "user1@example.com")) 299))
            ;; A link of A's entry in B's document, which A's gates pass.
            b (assoc b :shared-link (id (create-vocab-link admin-request (:item a) [(:t2 b)])))
            [_ _ _ body] (some #(when (= label (first %)) %) (bulk-cases a b))
            before (snapshot b)
            resp (api-call user1-request {:method method :path path :body body})]
        (is (<= 400 (:status resp) 499) (str "answered " (:status resp) " " (:body resp)))
        (is (= before (snapshot b)) "B is as it was")))))

(deftest each-list-is-accepted-within-one-project
  ;; The refusals above are about the second project, not a malformed list:
  ;; the same lists with both entries in A go through.
  (let [a (world "A")
        a2 {:token-layer (:token-layer a) :text (:text a) :span-layer (:span-layer a)
            :relation-layer (:relation-layer a) :vocab (:vocab a)
            :t1 (:t2 a) :t2 (:t1 a) :s1 (:s2 a) :s2 (:s1 a)}
        _ (assert-status 204 (add-project-writer admin-request (:project a) "user1@example.com"))]
    (doseq [[label method path body] (bulk-cases a a2)
            :when (#{"tokens create" "tokens update" "spans create" "spans update"
                     "vocab items create"} label)]
      (testing label
        (let [resp (api-call user1-request {:method method :path path :body body})]
          (is (<= 200 (:status resp) 299) (str "answered " (:status resp) " " (:body resp))))))))
