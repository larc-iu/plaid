(ns plaid.rest-api.v1.token-constraint-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-created assert-ok assert-no-content assert-bad-request
                                    with-admin with-test-users]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin with-test-users)

;; ---------------------------------------------------------------------------
;; Helpers
;; ---------------------------------------------------------------------------

(defn- setup-layer
  "Create project, doc, text-layer, text, and token-layer. Returns map of IDs."
  [overlap-mode text-body]
  (let [proj (create-test-project admin-request "ConstraintProj")
        doc (create-test-document admin-request proj "Doc")
        tl-res (create-text-layer admin-request proj "TL")
        tl (-> tl-res :body :id)
        _ (assert-created tl-res)
        text-res (create-text admin-request tl doc text-body)
        text-id (-> text-res :body :id)
        _ (assert-created text-res)
        tkl-res (create-token-layer admin-request tl "TKL" overlap-mode)
        tkl (-> tkl-res :body :id)
        _ (assert-created tkl-res)]
    {:project proj :doc doc :text-layer tl :text-id text-id :token-layer tkl}))

;; ---------------------------------------------------------------------------
;; Overlap mode on token layer
;; ---------------------------------------------------------------------------

(deftest token-layer-overlap-mode
  (testing "Default overlap mode is :any"
    (let [{:keys [token-layer]} (setup-layer nil "hello")]
      (let [res (api-call admin-request {:method :get
                                         :path (str "/api/v1/token-layers/" token-layer)})]
        (assert-ok res)
        (is (= :any (-> res :body :token-layer/overlap-mode))))))

  (testing "Can create with explicit overlap modes"
    (doseq [mode ["any" "non-overlapping" "partitioning"]]
      (let [{:keys [token-layer]} (setup-layer mode "hello")]
        (let [res (api-call admin-request {:method :get
                                           :path (str "/api/v1/token-layers/" token-layer)})]
          (assert-ok res)
          (is (= (keyword mode) (-> res :body :token-layer/overlap-mode)))))))

  (testing "Overlap mode is immutable (PATCH doesn't change it)"
    (let [{:keys [token-layer]} (setup-layer "non-overlapping" "hello")]
      ;; PATCH only allows :name
      (let [res (api-call admin-request {:method :patch
                                         :path (str "/api/v1/token-layers/" token-layer)
                                         :body {:name "NewName"}})]
        (assert-ok res)
        (is (= :non-overlapping (-> res :body :token-layer/overlap-mode)))))))

;; ---------------------------------------------------------------------------
;; :non-overlapping constraints
;; ---------------------------------------------------------------------------

(deftest non-overlapping-single-create
  (let [{:keys [token-layer text-id]} (setup-layer "non-overlapping" "hello world")]
    (testing "Non-overlapping tokens can be created"
      (let [r1 (create-token admin-request token-layer text-id 0 5)]
        (assert-created r1))
      (let [r2 (create-token admin-request token-layer text-id 6 11)]
        (assert-created r2)))

    (testing "Overlapping token is rejected"
      (let [r (create-token admin-request token-layer text-id 3 8)]
        (assert-status 409 r)))))

(deftest non-overlapping-update-rejected
  (let [{:keys [token-layer text-id]} (setup-layer "non-overlapping" "hello world")]
    (let [r1 (create-token admin-request token-layer text-id 0 5)
          t1 (-> r1 :body :id)
          r2 (create-token admin-request token-layer text-id 6 11)
          t2 (-> r2 :body :id)]
      (assert-created r1)
      (assert-created r2)

      (testing "Updating to overlap is rejected"
        (let [r (update-token admin-request t1 :end 8)]
          (assert-status 409 r)))

      (testing "Non-overlapping update succeeds"
        (let [r (update-token admin-request t1 :end 6)]
          (assert-ok r))))))

(deftest non-overlapping-bulk-create
  (let [{:keys [token-layer text-id]} (setup-layer "non-overlapping" "hello world!")]
    (testing "Non-overlapping batch succeeds"
      (let [tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 5}
                    {:token-layer-id token-layer :text text-id :begin 6 :end 11}]
            res (bulk-create-tokens admin-request tokens)]
        (assert-created res)
        (bulk-delete-tokens admin-request (-> res :body :ids))))

    (testing "Overlapping batch is rejected"
      (let [tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 5}
                    {:token-layer-id token-layer :text text-id :begin 3 :end 8}]
            res (bulk-create-tokens admin-request tokens)]
        (assert-bad-request res)))))

;; ---------------------------------------------------------------------------
;; :partitioning constraints
;; ---------------------------------------------------------------------------

(deftest partitioning-single-create-rejected
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello")]
    (testing "Single create is rejected"
      (let [r (create-token admin-request token-layer text-id 0 5)]
        (assert-bad-request r)))))

(deftest partitioning-bulk-create-valid-partition
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")]
    (testing "Valid partition succeeds"
      (let [tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 6}
                    {:token-layer-id token-layer :text text-id :begin 6 :end 12}]
            res (bulk-create-tokens admin-request tokens)]
        (assert-created res)))))

(deftest partitioning-bulk-create-rejects-gap
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")]
    (testing "Partition with gap is rejected"
      (let [tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 5}
                    {:token-layer-id token-layer :text text-id :begin 6 :end 12}]
            res (bulk-create-tokens admin-request tokens)]
        (assert-bad-request res)))))

(deftest partitioning-bulk-create-rejects-partial-coverage
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")]
    (testing "Partition not covering start is rejected"
      (let [tokens [{:token-layer-id token-layer :text text-id :begin 1 :end 12}]
            res (bulk-create-tokens admin-request tokens)]
        (assert-bad-request res)))
    (testing "Partition not covering end is rejected"
      (let [tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 11}]
            res (bulk-create-tokens admin-request tokens)]
        (assert-bad-request res)))))

(deftest partitioning-direct-update-rejected
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")]
    (let [tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 6}
                  {:token-layer-id token-layer :text text-id :begin 6 :end 12}]
          res (bulk-create-tokens admin-request tokens)
          t1 (first (-> res :body :ids))]
      (assert-created res)
      (testing "Direct PATCH is rejected"
        (let [r (update-token admin-request t1 :end 5)]
          (assert-bad-request r))))))

(deftest partitioning-single-delete-rejected
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")]
    (let [tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 6}
                  {:token-layer-id token-layer :text text-id :begin 6 :end 12}]
          res (bulk-create-tokens admin-request tokens)
          t1 (first (-> res :body :ids))]
      (assert-created res)
      (testing "Single delete is rejected"
        (let [r (delete-token admin-request t1)]
          (assert-bad-request r))))))

(deftest partitioning-bulk-delete-all-succeeds
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")]
    (let [tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 6}
                  {:token-layer-id token-layer :text text-id :begin 6 :end 12}]
          res (bulk-create-tokens admin-request tokens)
          ids (-> res :body :ids)]
      (assert-created res)
      (testing "Bulk delete of ALL tokens succeeds"
        (assert-no-content (bulk-delete-tokens admin-request ids))))))

;; ---------------------------------------------------------------------------
;; Split operation
;; ---------------------------------------------------------------------------

(deftest split-token-any-mode
  (let [{:keys [token-layer text-id]} (setup-layer "any" "hello world!")]
    (let [r (create-token admin-request token-layer text-id 0 12)
          tok-id (-> r :body :id)]
      (assert-created r)
      (testing "Split creates two tokens"
        (let [split-res (split-token admin-request tok-id 5)
              new-id (-> split-res :body :id)]
          (assert-created split-res)
          ;; Left half keeps original ID
          (let [left (get-token admin-request tok-id)]
            (assert-ok left)
            (is (= 0 (-> left :body :token/begin)))
            (is (= 5 (-> left :body :token/end))))
          ;; Right half is new
          (let [right (get-token admin-request new-id)]
            (assert-ok right)
            (is (= 5 (-> right :body :token/begin)))
            (is (= 12 (-> right :body :token/end)))))))))

(deftest split-token-partitioning-mode
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")]
    (let [tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 6}
                  {:token-layer-id token-layer :text text-id :begin 6 :end 12}]
          res (bulk-create-tokens admin-request tokens)
          [t1 _t2] (-> res :body :ids)]
      (assert-created res)
      (testing "Split on partitioning layer works"
        (let [split-res (split-token admin-request t1 3)
              new-id (-> split-res :body :id)]
          (assert-created split-res)
          (let [left (get-token admin-request t1)]
            (assert-ok left)
            (is (= 0 (-> left :body :token/begin)))
            (is (= 3 (-> left :body :token/end))))
          (let [right (get-token admin-request new-id)]
            (assert-ok right)
            (is (= 3 (-> right :body :token/begin)))
            (is (= 6 (-> right :body :token/end)))))))))

(deftest split-invalid-position
  (let [{:keys [token-layer text-id]} (setup-layer "any" "hello")]
    (let [r (create-token admin-request token-layer text-id 0 5)
          tok-id (-> r :body :id)]
      (assert-created r)
      (testing "Position at begin is rejected"
        (assert-bad-request (split-token admin-request tok-id 0)))
      (testing "Position at end is rejected"
        (assert-bad-request (split-token admin-request tok-id 5)))
      (testing "Position outside token is rejected"
        (assert-bad-request (split-token admin-request tok-id 6))))))

;; ---------------------------------------------------------------------------
;; Merge operation
;; ---------------------------------------------------------------------------

(deftest merge-tokens-any-mode
  (let [{:keys [token-layer text-id]} (setup-layer "any" "hello world!")]
    (let [r1 (create-token admin-request token-layer text-id 0 5)
          t1 (-> r1 :body :id)
          r2 (create-token admin-request token-layer text-id 6 12)
          t2 (-> r2 :body :id)]
      (assert-created r1)
      (assert-created r2)
      (testing "Merge two tokens"
        (let [merge-res (merge-tokens admin-request t1 t2)]
          (assert-ok merge-res)
          ;; Left token survives with merged extent
          (let [merged (get-token admin-request t1)]
            (assert-ok merged)
            (is (= 0 (-> merged :body :token/begin)))
            (is (= 12 (-> merged :body :token/end))))
          ;; Right token is deleted
          (is (= 404 (:status (get-token admin-request t2)))))))))

(deftest merge-tokens-partitioning-adjacent
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")]
    (let [tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 6}
                  {:token-layer-id token-layer :text text-id :begin 6 :end 12}]
          res (bulk-create-tokens admin-request tokens)
          [t1 t2] (-> res :body :ids)]
      (assert-created res)
      (testing "Merge adjacent tokens on partitioning layer"
        (let [merge-res (merge-tokens admin-request t1 t2)]
          (assert-ok merge-res)
          (let [merged (get-token admin-request t1)]
            (assert-ok merged)
            (is (= 0 (-> merged :body :token/begin)))
            (is (= 12 (-> merged :body :token/end)))))))))

(deftest merge-tokens-partitioning-non-adjacent-rejected
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")]
    (let [tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 4}
                  {:token-layer-id token-layer :text text-id :begin 4 :end 8}
                  {:token-layer-id token-layer :text text-id :begin 8 :end 12}]
          res (bulk-create-tokens admin-request tokens)
          [t1 _t2 t3] (-> res :body :ids)]
      (assert-created res)
      (testing "Merge non-adjacent tokens on partitioning layer is rejected"
        (let [merge-res (merge-tokens admin-request t1 t3)]
          (assert-bad-request merge-res))))))

(deftest merge-tokens-reparents-spans
  (let [{:keys [token-layer text-id]} (setup-layer "any" "hello world!")]
    (let [r1 (create-token admin-request token-layer text-id 0 5)
          t1 (-> r1 :body :id)
          r2 (create-token admin-request token-layer text-id 6 12)
          t2 (-> r2 :body :id)
          _ (assert-created r1)
          _ (assert-created r2)
          sl-res (create-span-layer admin-request token-layer "SL")
          sl (-> sl-res :body :id)
          _ (assert-created sl-res)
          ;; Create span referencing t2
          span-res (create-span admin-request sl [t2] "test-span")
          span-id (-> span-res :body :id)
          _ (assert-created span-res)]
      (testing "After merge, span references surviving token"
        (let [merge-res (merge-tokens admin-request t1 t2)]
          (assert-ok merge-res)
          (let [span (get-span admin-request span-id)]
            (assert-ok span)
            (is (= [t1] (-> span :body :span/tokens)))))))))
;; ---------------------------------------------------------------------------
;; Shift boundary operation
;; ---------------------------------------------------------------------------

(deftest shift-boundary-any-mode
  (let [{:keys [token-layer text-id]} (setup-layer "any" "hello world!")]
    (let [r (create-token admin-request token-layer text-id 0 5)
          tok-id (-> r :body :id)]
      (assert-created r)
      (testing "Shift on :any is like regular update"
        (let [res (shift-token-boundary admin-request tok-id :end 8)]
          (assert-ok res)
          (is (= 8 (-> res :body :token/end))))))))

(deftest shift-boundary-partitioning-adjusts-neighbor
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")]
    (let [tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 6}
                  {:token-layer-id token-layer :text text-id :begin 6 :end 12}]
          res (bulk-create-tokens admin-request tokens)
          [t1 t2] (-> res :body :ids)]
      (assert-created res)
      (testing "Shifting end adjusts right neighbor's begin"
        (let [shift-res (shift-token-boundary admin-request t1 :end 8)]
          (assert-ok shift-res)
          (is (= 8 (-> shift-res :body :token/end)))
          ;; Right neighbor should have begin=8
          (let [right (get-token admin-request t2)]
            (assert-ok right)
            (is (= 8 (-> right :body :token/begin)))))))))

(deftest shift-boundary-non-overlapping-validates
  (let [{:keys [token-layer text-id]} (setup-layer "non-overlapping" "hello world!")]
    (let [r1 (create-token admin-request token-layer text-id 0 5)
          t1 (-> r1 :body :id)
          r2 (create-token admin-request token-layer text-id 6 12)
          _t2 (-> r2 :body :id)]
      (assert-created r1)
      (assert-created r2)
      (testing "Shift that would overlap is rejected"
        (let [res (shift-token-boundary admin-request t1 :end 8)]
          (assert-status 409 res)))
      (testing "Shift that doesn't overlap succeeds"
        (let [res (shift-token-boundary admin-request t1 :end 6)]
          (assert-ok res))))))

;; ---------------------------------------------------------------------------
;; Text cascade compensation
;; ---------------------------------------------------------------------------

;; (text-cascade-partitioning-fills-gaps removed — it only asserted the tokens
;; still existed, never that the partition stayed gap-free; the test below
;; supersedes it with a real cover check.)

(deftest text-cascade-partitioning-maintains-valid-partition
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "abcdef")
        res (bulk-create-tokens admin-request
                                [{:token-layer-id token-layer :text text-id :begin 0 :end 3}
                                 {:token-layer-id token-layer :text text-id :begin 3 :end 6}])
        [t1 t2] (-> res :body :ids)]
    (assert-created res)
    (testing "Deleting text mid-body leaves tokens a gap-free cover of the new text"
      ;; "abcdef" (len 6) -> "abef" (len 4): delete "cd"
      (assert-ok (update-text admin-request text-id "abef"))
      (let [extents (->> [t1 t2]
                         (map #(get-token admin-request %))
                         (filter #(= 200 (:status %)))
                         (map #(vector (-> % :body :token/begin) (-> % :body :token/end)))
                         (sort-by first))]
        (is (= 0 (ffirst extents)) "partition starts at 0")
        (is (= 4 (-> extents last second)) "partition ends at new text length")
        (is (every? (fn [[[_ a-end] [b-begin _]]] (= a-end b-begin))
                    (partition 2 1 extents))
            (str "no gaps/overlaps between surviving tokens: " extents))))))

;; ---------------------------------------------------------------------------
;; Partitioning establishment is single-shot (pre-flight + concurrency assert)
;; ---------------------------------------------------------------------------

(deftest partitioning-second-establishment-rejected
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")
        tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 6}
                {:token-layer-id token-layer :text text-id :begin 6 :end 12}]]
    (assert-created (bulk-create-tokens admin-request tokens))
    (testing "A second bulk-create on a populated partitioning layer is rejected"
      (assert-status 409 (bulk-create-tokens admin-request tokens)))))

(deftest partitioning-concurrent-establishment-one-wins
  ;; Regular ops are NOT serialized against each other (see operation-coordinator),
  ;; so two establishments can both pass the pre-flight emptiness check concurrently.
  ;; partition-establish-assert-sql is what guarantees only one commits.
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")
        tokens [{:token-layer-id token-layer :text text-id :begin 0 :end 6}
                {:token-layer-id token-layer :text text-id :begin 6 :end 12}]
        results (->> (repeatedly 5 (fn [] (future (bulk-create-tokens admin-request tokens))))
                     doall
                     (mapv deref))
        successes (filter #(= 201 (:status %)) results)]
    (testing "Exactly one concurrent establishment succeeds"
      (is (= 1 (count successes))
          (str "Expected exactly one success, got statuses: " (mapv :status results))))
    (testing "The winning partition is intact (exactly two tokens)"
      (let [ids (-> successes first :body :ids)]
        (is (= 2 (count ids)))
        (doseq [id ids]
          (assert-ok (get-token admin-request id)))))))

;; ---------------------------------------------------------------------------
;; enforce branches not covered above
;; ---------------------------------------------------------------------------

(deftest partitioning-precedence-update-allowed
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")
        res (bulk-create-tokens admin-request
                                [{:token-layer-id token-layer :text text-id :begin 0 :end 6}
                                 {:token-layer-id token-layer :text text-id :begin 6 :end 12}])
        t1 (first (-> res :body :ids))]
    (assert-created res)
    (testing "Updating precedence only (no extent change) is allowed on partitioning"
      ;; extents-changing? is false, so the partitioning extent-change rejection
      ;; must NOT fire — we should not over-reject non-extent updates.
      (assert-ok (update-token admin-request t1 :precedence 5)))))

(deftest non-overlapping-merge-rejects-engulfing-third-token
  (let [{:keys [token-layer text-id]} (setup-layer "non-overlapping" "hello world!")
        t1 (-> (create-token admin-request token-layer text-id 0 3) :body :id)
        _t2 (-> (create-token admin-request token-layer text-id 4 7) :body :id)
        t3 (-> (create-token admin-request token-layer text-id 8 11) :body :id)]
    (testing "Merging two tokens whose span would engulf a third is rejected"
      ;; merged extent [0,11) overlaps the middle token [4,7)
      (assert-status 409 (merge-tokens admin-request t1 t3)))))

(deftest shift-boundary-partitioning-adjusts-left-neighbor
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")
        res (bulk-create-tokens admin-request
                                [{:token-layer-id token-layer :text text-id :begin 0 :end 6}
                                 {:token-layer-id token-layer :text text-id :begin 6 :end 12}])
        [t1 t2] (-> res :body :ids)]
    (assert-created res)
    (testing "Shifting a token's begin adjusts the left neighbor's end"
      (let [shift-res (shift-token-boundary admin-request t2 :begin 4)]
        (assert-ok shift-res)
        (is (= 4 (-> shift-res :body :token/begin)))
        (let [left (get-token admin-request t1)]
          (assert-ok left)
          (is (= 4 (-> left :body :token/end))))))))

(deftest shift-boundary-partitioning-outer-edge-rejected
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")
        res (bulk-create-tokens admin-request
                                [{:token-layer-id token-layer :text text-id :begin 0 :end 6}
                                 {:token-layer-id token-layer :text text-id :begin 6 :end 12}])
        [t1 t2] (-> res :body :ids)]
    (assert-created res)
    (testing "Shifting the first token's begin off 0 (no left neighbor) is rejected"
      (assert-bad-request (shift-token-boundary admin-request t1 :begin 2)))
    (testing "Shifting the last token's end off text length (no right neighbor) is rejected"
      (assert-bad-request (shift-token-boundary admin-request t2 :end 10)))))

(deftest partitioning-partial-bulk-delete-rejected
  (let [{:keys [token-layer text-id]} (setup-layer "partitioning" "hello world!")
        res (bulk-create-tokens admin-request
                                [{:token-layer-id token-layer :text text-id :begin 0 :end 6}
                                 {:token-layer-id token-layer :text text-id :begin 6 :end 12}])
        [t1 _t2] (-> res :body :ids)]
    (assert-created res)
    (testing "Deleting a subset of a partition is rejected (must delete all)"
      (assert-bad-request (bulk-delete-tokens admin-request [t1])))))

(deftest non-overlapping-merge-succeeds
  (let [{:keys [token-layer text-id]} (setup-layer "non-overlapping" "hello world!")
        t1 (-> (create-token admin-request token-layer text-id 0 3) :body :id)
        t2 (-> (create-token admin-request token-layer text-id 4 7) :body :id)]
    (testing "A clean merge on a non-overlapping layer succeeds"
      (let [merge-res (merge-tokens admin-request t1 t2)]
        (assert-ok merge-res)
        (let [merged (get-token admin-request t1)]
          (assert-ok merged)
          (is (= 0 (-> merged :body :token/begin)))
          (is (= 7 (-> merged :body :token/end))))
        (is (= 404 (:status (get-token admin-request t2))))))))

(deftest non-overlapping-bulk-create-rejects-overlap-with-existing
  (let [{:keys [token-layer text-id]} (setup-layer "non-overlapping" "hello world!")]
    (assert-created (create-token admin-request token-layer text-id 5 10))
    (testing "A batch token overlapping a pre-existing token is rejected"
      ;; no intra-batch overlap; [8,12) overlaps the pre-existing [5,10)
      (let [res (bulk-create-tokens admin-request
                                    [{:token-layer-id token-layer :text text-id :begin 0 :end 3}
                                     {:token-layer-id token-layer :text text-id :begin 8 :end 12}])]
        (assert-status 409 res)))))
