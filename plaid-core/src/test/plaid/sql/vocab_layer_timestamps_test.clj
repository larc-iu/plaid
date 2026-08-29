(ns plaid.sql.vocab-layer-timestamps-test
  "`vocab_layers.created_at` / `modified_at` (#vocab-layer-timestamps).

  A vocabulary had no notion of when it last changed, so vocabulary lists
  could not show the \"Updated\" column that project and document lists show.
  `modified_at` is now stamped by every write to the vocabulary: the layer
  itself (rename, config, a real maintainer change) and every item write,
  the latter via `plaid.sql.operation/touch-vocab-layers!` since an item
  write never touches the layer row on its own.

  Vocab LINKS are deliberately excluded: a link is an annotation on a
  document, not a change to the vocabulary it points at."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request api-call assert-ok assert-no-content
                                    with-admin with-test-users with-clean-db]]
            [plaid.test-helpers :refer [create-test-project
                                        create-text-layer
                                        create-token-layer
                                        create-text
                                        create-token
                                        create-vocab-layer
                                        get-vocab-layer
                                        update-vocab-layer
                                        add-vocab-maintainer
                                        create-vocab-item
                                        update-vocab-item
                                        delete-vocab-item
                                        update-vocab-item-metadata
                                        patch-vocab-item-metadata
                                        delete-vocab-item-metadata
                                        bulk-create-vocab-items
                                        bulk-delete-vocab-items
                                        create-vocab-link
                                        link-vocab-to-project]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private admin "admin@example.com")
(def ^:private user1 "user1@example.com")

(defn- times
  "[time-created time-modified] as served by the vocab-layer GET."
  [vocab-id]
  (let [b (:body (get-vocab-layer admin-request vocab-id))]
    [(:vocab/time-created b) (:vocab/time-modified b)]))

(defn- new-vocab! [name]
  (-> (create-vocab-layer admin-request name) :body :id))

(defn- vocab-layer-audit-rows
  "audit_writes rows targeting `vocab-id` from the most recent op of
  `op-type`. Used to assert that a write which already touches the layer
  row folds `modified_at` into its own audit row instead of adding one."
  [op-type vocab-id]
  (let [op-id (:id (psc/q1 db {:select [:id] :from [:operations]
                               :where [:= :op_type op-type]
                               :order-by [[:ts :desc]] :limit 1}))]
    (psc/q db {:select [:*] :from [:audit_writes]
               :where [:and
                       [:= :op_id op-id]
                       [:= :target_table "vocab_layers"]
                       [:= :target_id (str vocab-id)]]
               :order-by [:seq]})))

(defn- bumps?
  "Runs `f!` and reports whether it advanced the vocabulary's modified_at.
  Asserts created_at never moves."
  [vocab-id f!]
  (let [[created-before before] (times vocab-id)]
    (f!)
    (let [[created-after after] (times vocab-id)]
      (is (= created-before created-after) "created_at never moves")
      (and (some? after) (not= before after)))))

(deftest create-stamps-both-timestamps
  (let [v (new-vocab! "Timestamps")
        [created modified] (times v)]
    (is (some? created))
    (is (some? modified))
    (is (= created modified) "a brand-new vocabulary was last modified when it was created")))

(deftest item-writes-bump-the-layer
  (let [v (new-vocab! "ItemWrites")
        item (-> (create-vocab-item admin-request v "dog") :body :id)]
    (testing "create"
      ;; The create above already bumped it; prove it against a fresh layer
      ;; so the assertion isn't reading the layer's own creation stamp.
      (let [v2 (new-vocab! "ItemWrites2")]
        (is (bumps? v2 #(create-vocab-item admin-request v2 "cat")))))
    (testing "form update"
      (is (bumps? v #(update-vocab-item admin-request item "dogs"))))
    (testing "metadata put"
      (is (bumps? v #(update-vocab-item-metadata admin-request item {:pos "N"}))))
    (testing "metadata patch"
      (is (bumps? v #(patch-vocab-item-metadata admin-request item {:gloss "hund"}))))
    (testing "metadata delete"
      (is (bumps? v #(delete-vocab-item-metadata admin-request item))))
    (testing "delete"
      (is (bumps? v #(delete-vocab-item admin-request item))))))

(deftest bulk-item-writes-bump-the-layer
  (let [v (new-vocab! "BulkWrites")
        ids (atom nil)]
    (testing "bulk create"
      (is (bumps? v #(reset! ids (-> (bulk-create-vocab-items
                                      admin-request
                                      [{:vocab-layer-id v :form "one"}
                                       {:vocab-layer-id v :form "two"}])
                                     :body :ids)))))
    (testing "bulk delete resolves the layer before the rows go away"
      (is (bumps? v #(bulk-delete-vocab-items admin-request @ids))))))

(deftest layer-writes-bump-the-layer
  (let [v (new-vocab! "LayerWrites")]
    (testing "rename"
      (is (bumps? v #(update-vocab-layer admin-request v {:name "LayerWrites Renamed"})))
      (is (= 1 (count (vocab-layer-audit-rows "vocab/update" v)))
          "the rename folds modified_at into its own audit row"))
    (testing "config"
      (is (bumps? v #(api-call admin-request
                               {:method :put
                                :path (str "/api/v1/vocab-layers/" v "/config/plaid/color")
                                :body "blue"})))
      (is (= 1 (count (vocab-layer-audit-rows "layer/assoc-editor-config-pair" v)))
          "the config write folds modified_at into its own audit row"))
    (testing "a real maintainer change"
      (is (bumps? v #(assert-no-content (add-vocab-maintainer admin-request v user1)))))
    (testing "a maintainer add that grants nothing does not"
      (is (not (bumps? v #(add-vocab-maintainer admin-request v admin)))))))

(deftest vocab-links-do-not-bump-the-layer
  (let [proj (create-test-project admin-request "LinkProj")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
        doc (-> (api-call admin-request {:method :post
                                         :path "/api/v1/documents"
                                         :body {:project-id proj :name "Doc"}})
                :body :id)
        text (-> (create-text admin-request tl doc "hello world") :body :id)
        tok (-> (create-token admin-request tkl text 0 5) :body :id)
        v (new-vocab! "LinkVocab")
        _ (link-vocab-to-project admin-request proj v)
        item (-> (create-vocab-item admin-request v "hello") :body :id)]
    (is (not (bumps? v #(create-vocab-link admin-request item [tok])))
        "linking a word to an entry annotates the document, not the vocabulary")))

(deftest list-serves-the-timestamps
  (let [v (new-vocab! "ListShape")
        res (api-call admin-request {:method :get :path "/api/v1/vocab-layers"})
        entry (->> (:body res) :entries (filter #(= v (:vocab/id %))) first)]
    (assert-ok res)
    (is (= (times v) [(:vocab/time-created entry) (:vocab/time-modified entry)])
        "the list view carries the same timestamps as the single-vocab GET")))
