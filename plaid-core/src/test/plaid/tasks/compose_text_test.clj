(ns plaid.tasks.compose-text-test
  "The one-off conversion to composed text, on a database seeded with
  decomposed text the way an older core stored it."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler admin-request api-call
                                    with-admin with-clean-db]]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.operation :refer [submit-operation!]]
            [plaid.tasks.compose-text :as task]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- id-of [resp] (-> resp :body :id))

(defn- seed!
  "A project made through the API, then rows rewritten decomposed straight
  in the database, as a core before composing stored them: a body with
  marks around token edges and an astral letter, a tone mark segmented as
  its own morpheme, a value, metadata with two spellings of one key, names,
  a config, a vocabulary entry, a comment and a display name."
  []
  (let [proj (create-test-project admin-request "P")
        doc (create-test-document admin-request proj "D")
        tl (id-of (create-text-layer admin-request proj "T"))
        words (id-of (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}))
        morphs (id-of (create-token-layer-opts admin-request tl "Morphs" {:overlap-mode "non-overlapping"
                                                                          :parent-token-layer-id words}))
        gloss (id-of (create-span-layer admin-request morphs "Gloss"))
        text (id-of (create-text admin-request tl doc "x"))
        w1 (id-of (create-token admin-request words text 0 1))
        m1 (id-of (create-token admin-request morphs text 0 1))
        s1 (id-of (create-span admin-request gloss [m1] "g"))
        vl (id-of (create-vocab-layer admin-request "V"))
        item (id-of (create-vocab-item admin-request vl "f"))
        c (api-call admin-request {:method :post :path "/api/v1/comments"
                                   :body {:entity-type "span" :entity-id s1 :body "c"}})
        cid (-> c :body :comment/id)
        ;; t a ◌́ ␠ 𐐀 e ◌̂ ◌́ : words "ta◌́" [0 3] and "𐐀e◌̂◌́" [4 8],
        ;; morphemes "ta" [0 2], the tone [2 3], "𐐀e◌̂◌́" [4 8]
        body "ta\u0301 \uD801\uDC00e\u0302\u0301"
        state (volatile! {})]
    (submit-operation! [tx db {:type :text/update-body :project proj :document doc
                               :description "older core" :user "admin@example.com"}]
                       (crud/update-by-id! tx :texts text {:body body})
                       (crud/update-by-id! tx :tokens w1 {:begin 0 :end_ 3})
                       (crud/update-by-id! tx :tokens m1 {:begin 0 :end_ 2})
                       (let [tone (psc/new-uuid) w2 (psc/new-uuid) m2 (psc/new-uuid)]
                         (crud/insert! tx :tokens {:id tone :text_id text :token_layer_id morphs :document_id doc
                                                   :begin 2 :end_ 3})
                         (crud/insert! tx :tokens {:id w2 :text_id text :token_layer_id words :document_id doc
                                                   :begin 4 :end_ 8})
                         (crud/insert! tx :tokens {:id m2 :text_id text :token_layer_id morphs :document_id doc
                                                   :begin 4 :end_ 8})
                         (vswap! state assoc :tone tone :w2 w2 :m2 m2))
                       (crud/update-by-id! tx :spans s1 {:value (psc/write-json "glo\u0301ss")})
                       (metadata/replace-metadata! tx "span" s1 {"ke\u0301y" "va\u0301l" "kéy" "other"})
                       (crud/update-by-id! tx :documents doc {:name "Docu\u0301"})
                       (crud/update-by-id! tx :token_layers words {:config (psc/serialize-config {"igt" {"ta\u0301gs" ["ne\u0301g"]}})})
                       (crud/update-by-id! tx :vocab_items item {:form "ca\u0301sa"})
                       (psc/execute! tx {:update :comments :set {:body "Que\u0301?"} :where [:= :id cid]})
                       (crud/update-by-id! tx :users "admin@example.com" {:display_name "Jose\u0301"}))
    (merge @state {:proj proj :doc doc :text text :w1 w1 :m1 m1 :s1 s1 :item item :cid cid :words words})))

(defn- extent [id] ((juxt :begin :end_) (psc/fetch-by-id db :tokens id)))

(deftest a-dry-run-counts-and-writes-nothing
  (let [{:keys [text]} (seed!)
        ops (count (psc/q db {:select [:id] :from [:operations]}))
        r (task/run! db false)]
    (is (= {:texts 1 :tokens-moved 4 :tokens-left-zero-width 1 :metadata-entities 1 :metadata-keys-merged 1
            :applied false}
           (dissoc r :columns)))
    (is (= {"comments.body" 1 "documents.name" 1 "spans.value" 1 "token_layers.config" 1
            "users.display_name" 1 "vocab_items.form" 1}
           (:columns r)))
    (is (= "ta\u0301 \uD801\uDC00e\u0302\u0301" (:body (psc/fetch-by-id db :texts text))))
    (is (= ops (count (psc/q db {:select [:id] :from [:operations]}))))))

(deftest the-conversion-composes-everything-as-one-operation
  (let [{:keys [doc text w1 m1 tone w2 m2 s1 item cid words]} (seed!)
        version (:version (psc/fetch-by-id db :documents doc))
        modified (:modified_at (psc/fetch-by-id db :documents doc))
        r (task/run! db true)
        op-id (parse-uuid (:operation r))]
    (is (true? (:applied r)))
    (is (= 1 (:documents r)))
    (testing "the body and its tokens"
      ;; t á ␠ 𐐀 ế
      (is (= "tá \uD801\uDC00ế" (:body (psc/fetch-by-id db :texts text))))
      (is (= [0 2] (extent w1)))
      (is (= [0 2] (extent m1)))
      (is (= [2 2] (extent tone)) "the tone morpheme is left zero-width after its letter")
      (is (= [3 5] (extent w2)))
      (is (= [3 5] (extent m2))))
    (testing "every other column"
      (is (= "\"gl\\u00f3ss\"" (:value (psc/fetch-by-id db :spans s1))))
      (is (= {"kéy" "other"} (metadata/get-metadata db "span" s1)) "the composed key keeps one value")
      (is (= "Docú" (:name (psc/fetch-by-id db :documents doc))))
      (is (= {"igt" {"tágs" ["nég"]}} (psc/parse-config (:config (psc/fetch-by-id db :token_layers words)))))
      (is (= "cása" (:form (psc/fetch-by-id db :vocab_items item))))
      (is (= "Qué?" (:body (psc/fetch-by-id db :comments cid))))
      (is (= "José" (:display_name (psc/q1 db {:select [:display_name] :from [:users]
                                               :where [:= :id "admin@example.com"]})))))
    (testing "one operation, audited, a repair that bumps the version but not the time edited"
      (let [op (psc/fetch-by-id db :operations op-id)
            rows (psc/q db {:select [:target_table] :from [:audit_writes] :where [:= :op_id op-id]})]
        (is (= "text/compose" (:op_type op)))
        (is (= "repair" (:kind (psc/fetch-by-id db :operation_groups (:group_id op)))))
        (is (= #{"texts" "tokens" "spans" "documents" "token_layers" "vocab_items" "users"}
               (set (map :target_table rows))))
        (is (= (inc version) (:version (psc/fetch-by-id db :documents doc))))
        (is (= modified (:modified_at (psc/fetch-by-id db :documents doc))))))
    (testing "a second run finds nothing and records nothing"
      (let [ops (count (psc/q db {:select [:id] :from [:operations]}))
            r2 (task/run! db true)]
        (is (= 0 (:texts r2)))
        (is (empty? (:columns r2)))
        (is (nil? (:operation r2)))
        (is (= ops (count (psc/q db {:select [:id] :from [:operations]}))))))))
