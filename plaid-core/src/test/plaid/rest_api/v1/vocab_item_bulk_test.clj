(ns plaid.rest-api.v1.vocab-item-bulk-test
  "Tests for POST/PATCH/DELETE /vocab-items/bulk — the bulk vocab-item endpoints,
  sibling to the vocab-link bulk variants. Unlike vocab links, vocab items
  hang off a vocab LAYER (not a document), so there is no document/OCC
  version and entries may target different layers in one call."
  (:require [clojure.string :as str]
            [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request assert-status assert-created assert-ok
                                    assert-no-content assert-bad-request assert-forbidden
                                    with-admin with-test-users user1-request with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private user1 "user1@example.com")

(defn- setup
  "A project plus two vocab layers, both granted to the project."
  []
  (let [proj (create-test-project admin-request "BulkVI")
        v1 (-> (create-vocab-layer admin-request "V1") :body :id)
        v2 (-> (create-vocab-layer admin-request "V2") :body :id)]
    (link-vocab-to-project admin-request proj v1)
    (link-vocab-to-project admin-request proj v2)
    {:proj proj :v1 v1 :v2 v2}))

(deftest bulk-create-heterogeneous
  (testing "creates items across DIFFERENT vocab layers in one call"
    (let [{:keys [v1 v2]} (setup)
          res (bulk-create-vocab-items admin-request
                                       [{:vocab-layer-id v1 :form "dogs"}
                                        {:vocab-layer-id v2 :form "run"}
                                        {:vocab-layer-id v1 :form "cat"}])
          ids (-> res :body :ids)]
      (assert-created res)
      (is (= 3 (count ids)))
      (is (apply distinct? ids) "every item gets its own id")
      ;; Each item resolves with the right layer + form, in input order.
      (is (= v1 (-> (get-vocab-item admin-request (nth ids 0)) :body :vocab-item/layer)))
      (is (= "dogs" (-> (get-vocab-item admin-request (nth ids 0)) :body :vocab-item/form)))
      (is (= v2 (-> (get-vocab-item admin-request (nth ids 1)) :body :vocab-item/layer)))
      (is (= "run" (-> (get-vocab-item admin-request (nth ids 1)) :body :vocab-item/form)))
      (is (= v1 (-> (get-vocab-item admin-request (nth ids 2)) :body :vocab-item/layer))))))

(deftest bulk-create-with-metadata
  (testing "inline metadata is folded onto each created item"
    (let [{:keys [v1]} (setup)
          res (bulk-create-vocab-items admin-request
                                       [{:vocab-layer-id v1 :form "dogs"
                                         :metadata {"prov" "inferred" "provSource" "import:x"}}])
          item-id (-> res :body :ids first)]
      (assert-created res)
      (is (= "inferred" (-> (get-vocab-item admin-request item-id) :body :metadata (get "prov")))))))

(deftest bulk-create-rejects-bad-entry
  (testing "an unknown vocab layer fails the whole atomic batch (400)"
    (let [{:keys [v1]} (setup)]
      (assert-status 400
                     (bulk-create-vocab-items admin-request
                                              [{:vocab-layer-id v1 :form "dogs"}
                                               {:vocab-layer-id (random-uuid) :form "run"}])))))

(deftest bulk-create-rejects-empty
  (testing "an empty array is a 400 (at least one item required)"
    (setup)
    (assert-bad-request (bulk-create-vocab-items admin-request []))))

(deftest bulk-delete-cascades-links-and-drops-unknown
  (testing "bulk delete removes items + their descendant links; unknown ids dropped"
    (let [{:keys [proj v1]} (setup)
          ;; A doc + a token so we can link an item, to prove the cascade.
          doc (create-test-document admin-request proj "Doc")
          tl (-> (create-text-layer admin-request proj "TL") :body :id)
          text-id (-> (create-text admin-request tl doc "dogs run") :body :id)
          word (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}) :body :id)
          tok (-> (bulk-create-tokens admin-request [{:token-layer-id word :text text-id :begin 0 :end 4}]) :body :ids first)
          ids (-> (bulk-create-vocab-items admin-request
                                           [{:vocab-layer-id v1 :form "dogs"}
                                            {:vocab-layer-id v1 :form "run"}])
                  :body :ids)
          [i1 i2] ids
          link-id (-> (create-vocab-link admin-request i1 [tok]) :body :id)]
      ;; Sanity: the link exists before the delete.
      (assert-ok (get-vocab-link admin-request link-id))
      ;; Delete one real item + one bogus id → 204; the item AND its link gone.
      (assert-no-content (bulk-delete-vocab-items admin-request [i1 (random-uuid)]))
      (is (= 404 (:status (get-vocab-item admin-request i1))))
      (is (= 404 (:status (get-vocab-link admin-request link-id))) "descendant link cascaded")
      ;; The untouched item survives, then delete the rest.
      (assert-ok (get-vocab-item admin-request i2))
      (assert-no-content (bulk-delete-vocab-items admin-request [i2]))
      (is (= 404 (:status (get-vocab-item admin-request i2)))))))

(deftest bulk-delete-with-a-stale-id-at-the-head-answers-the-same-either-way
  ;; The coarse vocab-writer gate resolves the layer off the body. Reading
  ;; only the FIRST entry, an id a colleague had already deleted left it
  ;; unresolved and told a writer they "lack write access to vocab layer "
  ;; with no layer named, where the same list with the stale id second
  ;; deleted the rest and answered 204. The bulk update was taught this in
  ;; `bulk-update-unknown-id-at-the-head-is-a-404-for-a-writer`.
  (testing "a writer whose list starts with a stale id still deletes the rest"
    (let [{:keys [proj v1]} (setup)
          _ (add-project-writer admin-request proj user1)
          [i1 i2] (-> (bulk-create-vocab-items admin-request [{:vocab-layer-id v1 :form "dogs"}
                                                              {:vocab-layer-id v1 :form "run"}])
                      :body :ids)
          stale (random-uuid)
          head (bulk-delete-vocab-items user1-request [stale i1])
          tail (bulk-delete-vocab-items user1-request [i2 stale])]
      (assert-no-content head)
      (assert-no-content tail)
      (is (= (:status head) (:status tail)) "list order cannot change the answer")
      (is (= 404 (:status (get-vocab-item admin-request i1))))
      (is (= 404 (:status (get-vocab-item admin-request i2)))))))

(deftest bulk-requires-vocab-writer
  (testing "a user without write access to the layer cannot bulk create or delete"
    (let [{:keys [v1]} (setup)
          ids (-> (bulk-create-vocab-items admin-request [{:vocab-layer-id v1 :form "dogs"}]) :body :ids)]
      (assert-forbidden (bulk-create-vocab-items user1-request [{:vocab-layer-id v1 :form "x"}]))
      (assert-forbidden (bulk-delete-vocab-items user1-request ids)))))

(deftest writer-can-bulk
  (testing "a non-admin project writer (with the vocab granted) can bulk create + delete"
    (let [{:keys [proj v1]} (setup)
          _ (add-project-writer admin-request proj user1)
          res (bulk-create-vocab-items user1-request [{:vocab-layer-id v1 :form "dogs"}
                                                      {:vocab-layer-id v1 :form "run"}])
          ids (-> res :body :ids)]
      (assert-created res)
      (is (= 2 (count ids)))
      (assert-no-content (bulk-delete-vocab-items user1-request ids))
      (is (= 404 (:status (get-vocab-item admin-request (first ids))))))))

;; ---- PATCH /vocab-items/bulk ------------------------------------------------

(deftest bulk-update-forms-and-metadata
  (testing "one call sets forms across DIFFERENT layers and patches metadata"
    (let [{:keys [v1 v2]} (setup)
          [i1 i2] (-> (bulk-create-vocab-items admin-request
                                               [{:vocab-layer-id v1 :form "dogs"
                                                 :metadata {"pos" "N" "note" "keep"}}
                                                {:vocab-layer-id v2 :form "run"}])
                      :body :ids)
          res (bulk-update-vocab-items admin-request
                                       [{:id i1 :form "dog" :metadata [{:op "set" :path ["pos"] :value "NOUN"}]}
                                        {:id i2 :metadata [{:op "set" :path ["pos"] :value "V"}]}])]
      (assert-ok res)
      (is (= 2 (-> res :body :count)))
      (let [a (-> (get-vocab-item admin-request i1) :body)
            b (-> (get-vocab-item admin-request i2) :body)]
        (is (= "dog" (:vocab-item/form a)) "form set when the key is present")
        (is (= "NOUN" (-> a :metadata (get "pos"))) "a set key is overwritten")
        (is (= "keep" (-> a :metadata (get "note"))) "a key no op names is left untouched")
        (is (= "run" (:vocab-item/form b)) "an entry with no :form keeps its form")
        (is (= "V" (-> b :metadata (get "pos"))))))))

(deftest bulk-update-delete-op-removes-a-metadata-key
  (testing "a delete op removes that key, the same ops as PATCH /:id/metadata"
    (let [{:keys [v1]} (setup)
          id (-> (bulk-create-vocab-items admin-request
                                          [{:vocab-layer-id v1 :form "dogs"
                                            :metadata {"pos" "N" "note" "drop me"}}])
                 :body :ids first)]
      (assert-ok (bulk-update-vocab-items admin-request [{:id id :metadata [{:op "delete" :path ["note"]}]}]))
      (let [meta (-> (get-vocab-item admin-request id) :body :metadata)]
        (is (= "N" (get meta "pos")))
        (is (not (contains? meta "note")))))))

(deftest bulk-update-refuses-unknown-id-whole
  (testing "an unknown id 404s and nothing in the call is written"
    (let [{:keys [v1]} (setup)
          id (-> (bulk-create-vocab-items admin-request [{:vocab-layer-id v1 :form "dogs"}])
                 :body :ids first)]
      (assert-status 404 (bulk-update-vocab-items admin-request
                                                  [{:id id :form "dog"}
                                                   {:id (random-uuid) :form "x"}]))
      (is (= "dogs" (-> (get-vocab-item admin-request id) :body :vocab-item/form))
          "the whole update rolled back"))))

(deftest bulk-update-refuses-duplicate-and-empty
  (testing "an id may appear only once, and the list may not be empty"
    (let [{:keys [v1]} (setup)
          id (-> (bulk-create-vocab-items admin-request [{:vocab-layer-id v1 :form "dogs"}])
                 :body :ids first)]
      (assert-bad-request (bulk-update-vocab-items admin-request
                                                   [{:id id :form "a"} {:id id :form "b"}]))
      (assert-bad-request (bulk-update-vocab-items admin-request [])))))

(deftest bulk-update-unknown-id-at-the-head-is-a-404-for-a-writer
  ;; The coarse vocab-writer gate resolves the layer off the body. Reading
  ;; only the FIRST entry, a stale id at the head left it unresolved and
  ;; answered a member "lacks write access to vocab layer null" (403),
  ;; hiding the update's own 404 — and the same list with the stale id
  ;; second answered 404. The answer must not depend on list order.
  (testing "a writer whose list starts with a stale id gets the 404 naming it"
    (let [{:keys [proj v1]} (setup)
          _ (add-project-writer admin-request proj user1)
          id (-> (bulk-create-vocab-items admin-request [{:vocab-layer-id v1 :form "dogs"}])
                 :body :ids first)
          stale (random-uuid)
          head (bulk-update-vocab-items user1-request [{:id stale :form "x"}
                                                       {:id id :form "dog"}])
          tail (bulk-update-vocab-items user1-request [{:id id :form "dog"}
                                                       {:id stale :form "x"}])]
      (assert-status 404 head)
      (is (str/includes? (str (-> head :body :error)) (str stale))
          "and the 404 names the id the caller got wrong")
      (assert-status 404 tail)
      (is (= (:status head) (:status tail)) "list order cannot change the answer")
      (is (= "dogs" (-> (get-vocab-item admin-request id) :body :vocab-item/form))
          "nothing was written"))))

(deftest bulk-update-requires-vocab-writer
  (testing "a user without write access to the layer cannot bulk update"
    (let [{:keys [proj v1]} (setup)
          id (-> (bulk-create-vocab-items admin-request [{:vocab-layer-id v1 :form "dogs"}])
                 :body :ids first)]
      (assert-forbidden (bulk-update-vocab-items user1-request [{:id id :form "dog"}]))
      (add-project-writer admin-request proj user1)
      (assert-ok (bulk-update-vocab-items user1-request [{:id id :form "dog"}]))
      (is (= "dog" (-> (get-vocab-item admin-request id) :body :vocab-item/form))))))
