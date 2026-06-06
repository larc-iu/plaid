(ns plaid.rest-api.v1.metadata-test
  "Regression tests for metadata shape guards on routes that accept
  inline `:metadata` (tasks #110 and #118). Prior to #110, the
  shape-guard middleware was only attached to the dedicated /metadata
  routes; POST /spans, /tokens, etc. accepted inline metadata of any
  shape, defeating the depth/key-count/string-length caps."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-clean-db
                                    assert-created assert-ok assert-status]]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        create-text-layer create-text create-token-layer
                                        create-token create-span-layer create-span
                                        create-vocab-layer create-vocab-item
                                        update-vocab-item-metadata
                                        patch-vocab-item-metadata]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- nested-map [depth]
  (loop [d depth m {"leaf" 1}]
    (if (zero? d) m (recur (dec d) {"k" m}))))

(deftest validate-metadata-shape-detects-overdeep-payload
  ;; Unit test of the public helper used by the inline-metadata guard.
  (testing "validate-metadata-shape! returns an error string when depth exceeds the cap"
    (let [bad (nested-map 12)
          err (metadata/validate-metadata-shape! bad)]
      (is (some? err))
      (is (re-find #"depth" err)))))

(deftest validate-metadata-shape-accepts-shallow-payload
  (testing "Shallow payload returns nil (no error)"
    (is (nil? (metadata/validate-metadata-shape!
               {"a" 1 "b" "two" "c" {"nested" true}})))))

(deftest validate-metadata-shape-rejects-oversize-total-bytes
  ;; #118 — a payload that passes individual key/depth/string caps but
  ;; whose JSON serialization exceeds 1 MB must be rejected.
  (testing "Cumulative-bytes cap rejects huge-but-shallow payloads"
    ;; 500 keys (within the 500-key cap) × ~2.5KB values (well below the
    ;; 10KB per-string cap) = ~1.25MB > 1MB cap.
    (let [val (apply str (repeat 2600 \x))
          m (into {} (for [i (range 500)] [(str "k" i) val]))
          err (metadata/validate-metadata-shape! m)]
      (is (some? err) "Cumulative byte-size cap must fire")
      (is (re-find #"(?i)bytes|size" err)))))

(deftest post-span-with-overdeep-inline-metadata-returns-400
  ;; #110 regression: POST /spans accepts inline :metadata in its body.
  ;; Before #110 the dedicated /metadata route had a shape guard but
  ;; this route didn't, so a 12-deep payload would slip through and be
  ;; persisted. Assert the route now returns 400 for an over-deep map.
  (testing "POST /spans rejects 12-deep inline metadata with 400"
    (let [proj (create-test-project admin-request "InlineMetaDeepProj")
          doc (create-test-document admin-request proj "Doc")
          tl (-> (create-text-layer admin-request proj "TL") :body :id)
          text-id (-> (create-text admin-request tl doc "abc def") :body :id)
          tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
          tok (-> (create-token admin-request tkl text-id 0 3) :body :id)
          sl (-> (create-span-layer admin-request tkl "SL") :body :id)
          ;; A 12-deep nested map — well past the 10-deep cap.
          bad-metadata (nested-map 12)
          res (create-span admin-request sl [tok] "v" bad-metadata)]
      (assert-status 400 res)
      (is (re-find #"(?i)depth|metadata" (-> res :body :error))))))

(deftest post-span-with-well-shaped-inline-metadata-succeeds
  ;; Counterpart: a normal inline metadata blob still works after the
  ;; guard is added, so we didn't regress the happy path.
  (testing "POST /spans accepts shallow inline metadata"
    (let [proj (create-test-project admin-request "InlineMetaOkProj")
          doc (create-test-document admin-request proj "Doc")
          tl (-> (create-text-layer admin-request proj "TL") :body :id)
          text-id (-> (create-text admin-request tl doc "abc def") :body :id)
          tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
          tok (-> (create-token admin-request tkl text-id 0 3) :body :id)
          sl (-> (create-span-layer admin-request tkl "SL") :body :id)
          res (create-span admin-request sl [tok] "v" {"author" "me" "scores" [1 2 3]})]
      (assert-created res))))

;; vocab-item has hand-written (non-generator) metadata routes that previously
;; omitted the shape guard the doc-scoped entities enforce. These pin the guard
;; onto the dedicated PUT and PATCH metadata routes.

(deftest put-vocab-item-overdeep-metadata-returns-400
  (testing "PUT /vocab-items/:id/metadata rejects a 12-deep map with 400"
    (let [vocab (-> (create-vocab-layer admin-request "VItemShapePutVocab") :body :id)
          item (-> (create-vocab-item admin-request vocab "w") :body :id)
          res (update-vocab-item-metadata admin-request item (nested-map 12))]
      (assert-status 400 res)
      (is (re-find #"(?i)depth|metadata" (-> res :body :error))))))

(deftest patch-vocab-item-overdeep-metadata-returns-400
  (testing "PATCH /vocab-items/:id/metadata rejects a 12-deep map with 400"
    (let [vocab (-> (create-vocab-layer admin-request "VItemShapePatchVocab") :body :id)
          item (-> (create-vocab-item admin-request vocab "w") :body :id)
          res (patch-vocab-item-metadata admin-request item (nested-map 12))]
      (assert-status 400 res)
      (is (re-find #"(?i)depth|metadata" (-> res :body :error))))))

(deftest vocab-item-shallow-metadata-still-ok
  (testing "well-shaped vocab-item metadata still succeeds via PUT and PATCH"
    (let [vocab (-> (create-vocab-layer admin-request "VItemShapeOkVocab") :body :id)
          item (-> (create-vocab-item admin-request vocab "w") :body :id)]
      (assert-ok (update-vocab-item-metadata admin-request item {"a" "1"}))
      (assert-ok (patch-vocab-item-metadata admin-request item {"b" "2"})))))
