(ns plaid.rest-api.v1.client-id-test
  "A create may name the id of what it makes, a UUIDv7 the client minted, so
  a retry of a create whose answer was lost lands under the same id or is
  told the id is taken. Every create that answers an id takes one."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db admin-request user1-request with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db
                                    api-call assert-created]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :refer [create-test-project create-text-layer
                                        create-token-layer create-text create-token
                                        create-span-layer create-span create-relation-layer
                                        create-vocab-layer link-vocab-to-project]])
  (:import (java.util UUID)))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- post [path body]
  (api-call admin-request {:method :post :path path :body body}))

(defn- v7-at
  "A UUIDv7 stamped `ms` milliseconds after the epoch."
  [ms]
  (UUID. (bit-or (bit-shift-left ms 16) 0x7000 0x123)
         (bit-or (bit-shift-left 1 63) 0x0123456789ABCDEF)))

(defn- setup! []
  (let [proj (create-test-project admin-request "Ids")
        tl (-> (create-text-layer admin-request proj "T") :body :id)
        tkl (-> (create-token-layer admin-request tl "W") :body :id)
        sl (-> (create-span-layer admin-request tkl "S") :body :id)
        rl (-> (create-relation-layer admin-request sl "R") :body :id)
        vocab (-> (create-vocab-layer admin-request "Lex") :body :id)
        _ (link-vocab-to-project admin-request proj vocab)
        doc (-> (post "/api/v1/documents" {:project-id proj :name "D"}) :body :id)
        text (-> (create-text admin-request tl doc "dog barks loud") :body :id)
        tok (-> (create-token admin-request tkl text 0 3) :body :id)
        tok2 (-> (create-token admin-request tkl text 4 9) :body :id)
        span (-> (create-span admin-request sl [tok] "A") :body :id)
        span2 (-> (create-span admin-request sl [tok2] "B") :body :id)
        item (-> (post "/api/v1/vocab-items" {:vocab-layer-id vocab :form "dog"}) :body :id)]
    {:proj proj :tl tl :tkl tkl :sl sl :rl rl :vocab vocab :doc doc :text text
     :tok tok :tok2 tok2 :span span :span2 span2 :item item}))

(defn- creates
  "Every create that answers an id: [what table path body-fn], where
  body-fn takes the setup and the id to name."
  []
  [["project" :projects "/api/v1/projects" (fn [_ id] {:id id :name "P2"})]
   ["document" :documents "/api/v1/documents" (fn [s id] {:id id :project-id (:proj s) :name "D2"})]
   ["text layer" :text_layers "/api/v1/text-layers" (fn [s id] {:id id :project-id (:proj s) :name "T2"})]
   ["token layer" :token_layers "/api/v1/token-layers" (fn [s id] {:id id :text-layer-id (:tl s) :name "W2"})]
   ["span layer" :span_layers "/api/v1/span-layers" (fn [s id] {:id id :token-layer-id (:tkl s) :name "S2"})]
   ["relation layer" :relation_layers "/api/v1/relation-layers" (fn [s id] {:id id :span-layer-id (:sl s) :name "R2"})]
   ["vocab layer" :vocab_layers "/api/v1/vocab-layers" (fn [_ id] {:id id :name "V2"})]
   ["text" :texts "/api/v1/texts"
    (fn [s id]
      (let [doc (-> (post "/api/v1/documents" {:project-id (:proj s) :name (str "Dt" (rand-int 100000))}) :body :id)]
        {:id id :text-layer-id (:tl s) :document-id doc :body "x"}))]
   ["token" :tokens "/api/v1/tokens" (fn [s id] {:id id :token-layer-id (:tkl s) :text (:text s) :begin 10 :end 14})]
   ["span" :spans "/api/v1/spans" (fn [s id] {:id id :span-layer-id (:sl s) :tokens [(:tok s)] :value "N"})]
   ["relation" :relations "/api/v1/relations" (fn [s id] {:id id :layer-id (:rl s) :source-id (:span s) :target-id (:span2 s) :value "r"})]
   ["vocab item" :vocab_items "/api/v1/vocab-items" (fn [s id] {:id id :vocab-layer-id (:vocab s) :form "cat"})]
   ["vocab link" :vocab_links "/api/v1/vocab-links" (fn [s id] {:id id :vocab-item (:item s) :tokens [(:tok s)]})]
   ["guideline" :guidelines (fn [s] (str "/api/v1/projects/" (:proj s) "/guidelines")) (fn [_ id] {:id id :title "G"})]
   ["comment" :comments "/api/v1/comments" (fn [s id] {:id id :entity-type "document" :entity-id (:doc s) :body "c"})]])

(defn- path-of [path s] (if (fn? path) (path s) path))

(deftest every-create-takes-an-id
  (let [s (setup!)]
    (doseq [[what table path body-fn] (creates)]
      (testing what
        (let [id (psc/new-uuid)
              r (post (path-of path s) (body-fn s id))]
          (is (= 201 (:status r)) (str what ": " (:body r)))
          (is (= (str id) (str (or (:id (:body r)) (:comment/id (:body r))))))
          (is (some? (psc/fetch-by-id db table (str id))) (str what " stored under the id"))))
      (testing (str what ", the same id again")
        (let [id (psc/new-uuid)
              _ (assert-created (post (path-of path s) (body-fn s id)))
              r (post (path-of path s) (body-fn s id))]
          (is (= 409 (:status r)))
          (is (= "id-taken" (get-in r [:body :error])))
          (is (true? (get-in r [:body :id-taken])))
          (is (false? (get-in r [:body :deleted])))
          (is (= (str id) (get-in r [:body :id]))))))))

(deftest ids-that-are-refused
  (let [s (setup!)
        body (fn [id] {:id id :span-layer-id (:sl s) :tokens [(:tok s)] :value "N"})]
    (doseq [[what id] [["a v4 id" (random-uuid)]
                       ["a time in 1970" (v7-at 1000)]
                       ["a time far ahead" (v7-at (+ (System/currentTimeMillis) (* 3 3600000)))]]]
      (testing what
        (let [r (post "/api/v1/spans" (body id))]
          (is (= 400 (:status r)))
          (is (re-find #"UUIDv7" (str (get-in r [:body :error])))))))
    (testing "a few minutes of clock skew pass"
      (assert-created (post "/api/v1/spans" (body (v7-at (+ (System/currentTimeMillis) 300000))))))))

(deftest a-deleted-id-is-never-used-again
  (let [s (setup!)
        id (psc/new-uuid)
        body {:id id :span-layer-id (:sl s) :tokens [(:tok s)] :value "N"}]
    (assert-created (post "/api/v1/spans" body))
    (is (= 204 (:status (api-call admin-request {:method :delete :path (str "/api/v1/spans/" id)}))))
    (let [r (post "/api/v1/spans" body)]
      (is (= 409 (:status r)))
      (is (true? (get-in r [:body :id-taken])))
      (is (true? (get-in r [:body :deleted])))
      (is (re-find #"existed" (get-in r [:body :message]))))))

(deftest bulk-creates
  (let [s (setup!)
        [a b] (repeatedly 2 psc/new-uuid)]
    (testing "items may mix client and server ids"
      (let [r (post "/api/v1/spans/bulk" [{:id a :span-layer-id (:sl s) :tokens [(:tok s)] :value 1}
                                          {:span-layer-id (:sl s) :tokens [(:tok2 s)] :value 2}])]
        (is (= 201 (:status r)))
        (is (= (str a) (str (first (get-in r [:body :ids])))))))
    (testing "one id named twice is a 400"
      (is (= 400 (:status (post "/api/v1/tokens/bulk" [{:id b :token-layer-id (:tkl s) :text (:text s) :begin 10 :end 11}
                                                       {:id b :token-layer-id (:tkl s) :text (:text s) :begin 11 :end 12}])))))
    (testing "an id used before refuses the whole create"
      (let [r (post "/api/v1/vocab-items/bulk" [{:vocab-layer-id (:vocab s) :form "x"}
                                                {:id (:item s) :vocab-layer-id (:vocab s) :form "y"}])]
        (is (= 409 (:status r)))
        (is (true? (get-in r [:body :id-taken])))))
    (testing "links and relations"
      (let [[l r] (repeatedly 2 psc/new-uuid)]
        (is (= [(str l)] (map str (get-in (post "/api/v1/vocab-links/bulk" [{:id l :vocab-item (:item s) :tokens [(:tok2 s)]}]) [:body :ids]))))
        (is (= [(str r)] (map str (get-in (post "/api/v1/relations/bulk" [{:id r :relation-layer-id (:rl s) :source (:span2 s) :target (:span s) :value "x"}]) [:body :ids]))))))))

(deftest split-and-copy-take-an-id
  (let [s (setup!)
        right (psc/new-uuid)
        copy (psc/new-uuid)]
    (let [r (post (str "/api/v1/tokens/" (:tok2 s) "/split") {:id right :position 6})]
      (is (= 201 (:status r)))
      (is (= (str right) (str (get-in r [:body :id])))))
    (let [r (post (str "/api/v1/documents/" (:doc s) "/copy") {:id copy :name "Copy"})]
      (is (= 201 (:status r)))
      (is (= (str copy) (str (get-in r [:body :id])))))
    (testing "a split naming a taken id"
      (let [r (post (str "/api/v1/tokens/" (:tok s) "/split") {:id right :position 1})]
        (is (= 409 (:status r)))
        (is (true? (get-in r [:body :id-taken])))))))

(deftest in-a-batch-the-id-is-known-up-front
  (let [s (setup!)
        entry (psc/new-uuid)
        link (psc/new-uuid)
        r (api-call admin-request
                    {:method :post :path "/api/v1/batch"
                     :body [{:path "/api/v1/vocab-items" :method "POST"
                             :body {:id entry :vocab-layer-id (:vocab s) :form "new"}}
                            {:path "/api/v1/vocab-links" :method "POST"
                             :body {:id link :vocab-item entry :tokens [(:tok2 s)]}}]})]
    (is (= 200 (:status r)))
    (is (= [(str entry) (str link)] (map #(str (get-in % [:body :id])) (:body r))))))

(deftest comments-naming-one-id-at-once
  ;; REV-idempotency F7: two unkeyed creates naming one id answered 500.
  (let [s (setup!)]
    (dotimes [_ 5]
      (let [id (psc/new-uuid)
            sends (doall (repeatedly 3 #(future (post "/api/v1/comments"
                                                      {:id id :entity-type "document"
                                                       :entity-id (:doc s) :body "same"}))))
            statuses (sort (map (comp :status deref) sends))]
        (is (= [201 409 409] statuses))))))

(deftest a-non-member-is-refused-before-the-id-is-looked-at
  ;; REV-idempotency F8: the route's gates run before the id claim, so a
  ;; caller with no role on the project learns nothing of an id there. An
  ;; id-taken for an id in a project the caller cannot read is accepted, since
  ;; a UUIDv7 id is not guessable.
  (let [s (setup!)
        taken (-> (post "/api/v1/spans" {:id (psc/new-uuid) :span-layer-id (:sl s)
                                         :tokens [(:tok s)] :value "A"})
                  :body :id)
        r (api-call user1-request {:method :post :path "/api/v1/spans"
                                   :body {:id taken :span-layer-id (:sl s)
                                          :tokens [(:tok s)] :value "B"}})]
    (is (= 403 (:status r)))
    (is (nil? (get-in r [:body :id-taken])))))
