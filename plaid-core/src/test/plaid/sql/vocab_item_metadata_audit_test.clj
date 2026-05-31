(ns plaid.sql.vocab-item-metadata-audit-test
  "Task #74: when vocab-item/create was given metadata, the old code path
  emitted an :insert audit row WITHOUT the metadata folded into post_image,
  followed by a synthetic :update row from `metadata/insert-metadata!`.
  ETL replay sees a freshly-created entity \"updated\" milliseconds later
  — noisy and a parity break vs. span/vocab-link/relation/token create
  (which got the fold in Wave 5 via task #59).

  Fix: mirror the Wave 5 pattern — do a raw INSERT, call
  `metadata/insert-metadata!` with `{:skip-parent-audit? true}`, then emit
  one `:insert` audit row whose post_image carries `:metadata`."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-clean-db]]
            [plaid.test-helpers :refer [create-vocab-layer
                                        create-vocab-item]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(deftest vocab-item-create-with-metadata-emits-single-folded-insert
  (testing "vocab-item/create with metadata emits exactly ONE
            :vocab_items audit row with change_type :insert and
            :metadata folded into post_image — NOT a separate :update"
    (let [vocab (-> (create-vocab-layer admin-request "VocabItemMetaFoldVocab")
                    :body :id)
          metadata {:pos "noun" :gloss "greeting"}
          item-res (create-vocab-item admin-request vocab "hello" metadata)
          item-id (-> item-res :body :id)
          op (psc/q1 db {:select [:*] :from [:operations]
                         :where [:and
                                 [:= :op_type "vocab-item/create"]
                                 [:= :description (str "Create vocab item '" "hello" "'")]]
                         :order-by [[:ts :desc]] :limit 1})
          _ (is (some? op) "vocab-item/create op recorded")
          writes (psc/q db {:select [:*] :from [:audit_writes]
                            :where [:and
                                    [:= :op_id (:id op)]
                                    [:= :target_table "vocab_items"]
                                    [:= :target_id (str item-id)]]
                            :order-by [:seq]})]
      (is (= 1 (count writes))
          (str "expected exactly ONE :vocab_items audit row for the create op, got "
               (count writes) " (change_types: "
               (mapv :change_type writes) ")"))
      (let [w (first writes)]
        (is (= "insert" (:change_type w))
            "the sole row carries change_type :insert (no follow-up :update)")
        (is (nil? (:pre_image w)) "insert has no pre-image")
        (let [post (psc/read-json (:post_image w))]
          (is (some? post) "post-image present")
          (is (= "hello" (:form post)) "post-image includes form")
          (is (some? (:metadata post))
              (str "post-image carries :metadata — was " post))
          ;; clojure.data.json round-trips map keys as strings.
          (let [md (:metadata post)
                ks (set (map name (keys md)))]
            (is (= #{"pos" "gloss"} ks)
                (str "metadata keys round-tripped: " ks))))))))

(deftest vocab-item-create-without-metadata-still-emits-insert
  (testing "create with no metadata still emits a single :insert audit
            row, no extras"
    (let [vocab (-> (create-vocab-layer admin-request "VocabItemNoMetaVocab")
                    :body :id)
          item-res (create-vocab-item admin-request vocab "bare")
          item-id (-> item-res :body :id)
          op (psc/q1 db {:select [:*] :from [:operations]
                         :where [:and
                                 [:= :op_type "vocab-item/create"]
                                 [:= :description (str "Create vocab item '" "bare" "'")]]
                         :order-by [[:ts :desc]] :limit 1})
          writes (psc/q db {:select [:*] :from [:audit_writes]
                            :where [:and
                                    [:= :op_id (:id op)]
                                    [:= :target_table "vocab_items"]
                                    [:= :target_id (str item-id)]]
                            :order-by [:seq]})]
      (is (= 1 (count writes))
          (str "expected exactly 1 :vocab_items audit row, got " (count writes)))
      (is (= "insert" (:change_type (first writes))))
      (let [post (psc/read-json (:post_image (first writes)))]
        (is (nil? (:metadata post))
            "no :metadata folded when none was supplied")))))
