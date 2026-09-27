(ns plaid.history.vocab-history-review-test
  "Review probes for the vocabulary history and entry ACL (REV-R-VOCAB,
  2026-09-27). Three claims, each checked against an independent path:

  - The vocabulary read at any past write equals the live read right after
    it, and at now equals the live read, under seeded random churn through
    every entry verb (restore of a deleted entry included), and every row
    of the vocabulary carries its vocabulary.
  - The document and vocabulary feeds, walked page by page, give the units a
    whole-scope sort gives, across groups and batches that write both.
  - A rename needs the same right as a delete on every route, including
    under a delegated token, where an admin counts as a maintainer."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [db with-db with-mount-states with-rest-handler
                                            admin-request user1-request with-admin with-test-users
                                            api-call assert-created assert-ok assert-no-content
                                            assert-status with-clean-db]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.sql.audit :as audit]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :refer :all]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- enc [ts] (java.net.URLEncoder/encode (str ts) "UTF-8"))

(defn- latest-op-ts []
  (:ts (psc/q1 db {:select [:ts] :from [:operations] :order-by [[:ts :desc]] :limit 1})))

(defn- live-vocab [vocab]
  (:body (get-vocab-layer admin-request vocab true)))

(defn- vocab-at [vocab ts]
  (api-call admin-request {:method :get
                           :path (str "/api/v1/vocab-layers/" vocab "?include-items=true&as-of=" (enc ts))}))

(defn- restore-item! [vocab item ts]
  (api-call admin-request {:method :post
                           :path (str "/api/v1/vocab-layers/" vocab "/items/" item "/restore?as-of=" (enc ts))}))

;; ------------------------------------------------------------------
;; As-of equals live, under churn
;; ------------------------------------------------------------------

(defn- churn!
  "`steps` seeded random writes to `vocab` through every entry verb and
  the vocabulary's own. Returns `[[ts live-read] ...]`, one per write that
  landed, taken right after it."
  [vocab seed steps]
  (let [rng (java.util.Random. seed)
        pick (fn [xs] (when (seq xs) (nth (vec xs) (.nextInt rng (count xs)))))
        live-ids #(set (map :vocab-item/id (:vocab/items (live-vocab vocab))))
        ;; entry id -> a ts at which it existed, for putting it back later
        seen-at (atom {})
        snapshots (atom [])
        forms ["kai" "mata" "ta" "na" "kai" "sé" "a b"]
        gloss #(str "g" (.nextInt rng 5))]
    (dotimes [i steps]
      (let [ids (live-ids)
            gone (remove ids (keys @seen-at))
            id (pick ids)
            roll (.nextInt rng 15)
            r (cond
                (or (< roll 2) (empty? ids))
                (create-vocab-item admin-request vocab (pick forms)
                                   (when (zero? (.nextInt rng 2)) {"gloss" (gloss)}))
                (= roll 2) (update-vocab-item admin-request id (str (pick forms) i))
                (= roll 3) (update-vocab-item-metadata admin-request id {"gloss" (gloss) "pos" "N"})
                (= roll 4) (patch-vocab-item-metadata admin-request id [{:op "set" :path ["pos"] :value (gloss)}])
                (= roll 5) (delete-vocab-item-metadata admin-request id)
                (= roll 6) (bulk-create-vocab-items admin-request
                                                    [{:vocab-layer-id vocab :form (pick forms)}
                                                     {:vocab-layer-id vocab :form (pick forms)
                                                      :metadata {"gloss" (gloss)}}])
                (= roll 7) (bulk-update-vocab-items admin-request
                                                    (vec (for [x (take 2 (shuffle (vec ids)))]
                                                           (if (zero? (.nextInt rng 2))
                                                             {:id x :form (str (pick forms) "-" i)}
                                                             {:id x :metadata [{:op "set" :path ["gloss"] :value (gloss)}]}))))
                (= roll 8) (delete-vocab-item admin-request id)
                (= roll 9) (bulk-delete-vocab-items admin-request (vec (take 2 (shuffle (vec ids)))))
                (and (= roll 10) (seq gone))
                (let [g (pick gone)] (restore-item! vocab g (get @seen-at g)))
                (and (= roll 11) (seq @seen-at))
                ;; a living entry set back to an earlier state of itself
                (let [x (pick (filter ids (keys @seen-at)))]
                  (when x (restore-item! vocab x (get @seen-at x))))
                (= roll 12) (add-vocab-maintainer admin-request vocab
                                                  (pick ["user1@example.com" "user2@example.com"]))
                (= roll 13) (remove-vocab-maintainer admin-request vocab
                                                     (pick ["user1@example.com" "user2@example.com"]))
                :else (update-vocab-layer admin-request vocab {:name (str "Lexicon " i)}))]
        (when (and r (< 199 (:status r) 300))
          (let [ts (latest-op-ts)
                live (live-vocab vocab)]
            (doseq [it (:vocab/items live)]
              (swap! seen-at update (:vocab-item/id it) #(or % ts)))
            (swap! snapshots conj [ts live])))))
    @snapshots))

(deftest the-vocabulary-at-every-past-write-under-churn
  (doseq [seed [11 12 13]]
    (let [vocab (-> (create-vocab-layer admin-request (str "Churn " seed)) :body :id)
          snapshots (churn! vocab seed 70)]
      (testing (str "seed " seed)
        (is (< 40 (count snapshots)) "most writes landed")
        (is (some #(= :vocab-item/restore %)
                  (map (comp keyword :op_type)
                       (psc/q db {:select [:op_type] :from [:operations]
                                  :where [:= :op_type "vocab-item/restore"]})))
            "the churn put entries back")
        (doseq [[i [ts expected]] (map-indexed vector snapshots)]
          (let [r (vocab-at vocab ts)]
            (is (= 200 (:status r)) (str "write " i))
            (is (= expected (:body r)) (str "write " i))))
        (testing "at now, the live read"
          (is (= (live-vocab vocab) (:body (vocab-at vocab (java.time.Instant/now))))))
        (testing "every row of an entry or of the vocabulary carries the vocabulary"
          (is (= [] (psc/q db {:select [:target_table :change_type :vocab_layer_id]
                               :from [:audit_writes]
                               :where [:and
                                       [:in :target_table ["vocab_items" "vocab_layers"]]
                                       [:or [:= :vocab_layer_id nil]
                                        [:and [:= :target_table "vocab_layers"]
                                         [:<> :vocab_layer_id :target_id]]]]})))
          (is (= [] (psc/q db {:select [:target_id :vocab_layer_id]
                               :from [:audit_writes]
                               :where [:and
                                       [:= :target_table "vocab_items"]
                                       [:<> :vocab_layer_id (str vocab)]
                                       [:in :target_id {:select [:target_id]
                                                        :from [:audit_writes]
                                                        :where [:= :vocab_layer_id (str vocab)]}]]}))))))))

;; ------------------------------------------------------------------
;; The document and vocabulary feeds against a whole-scope sort
;; ------------------------------------------------------------------

(defn- unit-of [row] (or (:group_id row) (:batch_id row) (:id row)))

(defn- reference [rows desc?]
  (let [by-unit (group-by unit-of rows)
        pos (fn [ms] (let [tss (sort (map :ts ms))] (if desc? (last tss) (first tss))))]
    (->> by-unit
         (map (fn [[u ms]] [u (pos ms) (vec (sort (map :ts ms)))]))
         (sort-by second (if desc? #(compare %2 %1) compare))
         (mapv (fn [[u _ tss]] [(str u) tss])))))

(defn- walk [fetch limit order]
  (loop [cursor nil acc [] guard 0]
    (let [{:keys [entries next-cursor]} (fetch {:limit limit :cursor-vals cursor :order order})
          acc (into acc (map (fn [e] [(str (:audit/id e)) (mapv :op/time (:audit/ops e))])) entries)]
      (if (and next-cursor (< guard 2000))
        (recur next-cursor acc (inc guard))
        acc))))

(defn- with-group [path g] (str path (if (re-find #"\?" path) "&" "?") "group-id=" g))

(deftest the-document-and-vocabulary-feeds-match-a-whole-scope-sort
  (let [vocab (-> (create-vocab-layer admin-request "Feed") :body :id)
        proj (create-test-project admin-request "Feed")
        tl (-> (create-text-layer admin-request proj "Text") :body :id)
        tkl (-> (create-token-layer admin-request tl "Words") :body :id)
        _ (assert-no-content (link-vocab-to-project admin-request proj vocab))
        doc (create-test-document admin-request proj "Doc")
        text (-> (create-text admin-request tl doc "kai mata kai mata kai mata") :body :id)
        toks (vec (for [b [0 4 9 13 18 22]] (-> (create-token admin-request tkl text b (+ b 3)) :body :id)))
        rng (java.util.Random. 20260927)
        groups (vec (repeatedly 3 psc/new-uuid))
        items (atom [(-> (create-vocab-item admin-request vocab "kai") :body :id)])
        call! (fn [g m]
                (api-call admin-request (cond-> m g (update :path with-group g))))
        write! (fn [g i]
                 (case (.nextInt rng 5)
                   0 (call! g {:method :post :path "/api/v1/vocab-items"
                               :body {:vocab-layer-id vocab :form (str "w" i)}})
                   ;; a rename bumps the linking document's version: an op
                   ;; with no document of its own that belongs to its feed
                   1 (call! g {:method :patch :path (str "/api/v1/vocab-items/" (rand-nth @items))
                               :body {:form (str "r" i)}})
                   2 (call! g {:method :post :path "/api/v1/vocab-links"
                               :body {:vocab-item (rand-nth @items) :tokens [(nth toks (.nextInt rng 6))]}})
                   3 (call! g {:method :patch :path (str "/api/v1/documents/" doc) :body {:name (str "d" i)}})
                   4 (call! g {:method :put :path (str "/api/v1/vocab-items/" (rand-nth @items) "/metadata")
                               :body {"gloss" (str "g" i)}})))]
    (dotimes [i 80]
      (let [roll (.nextInt rng 10)
            r (cond
                (< roll 4) (write! (nth groups (.nextInt rng 3)) i)
                (< roll 5) (api-call admin-request
                                     {:method :post :path "/api/v1/batch"
                                      :body [{:path "/api/v1/vocab-items" :method "post"
                                              :body {:vocab-layer-id vocab :form (str "b" i)}}
                                             {:path (str "/api/v1/documents/" doc) :method "patch"
                                              :body {:name (str "b" i)}}]})
                :else (write! nil i))]
        (when-let [id (and (= 201 (:status r)) (-> r :body :id))]
          (when (-> r :body map?) (swap! items conj id)))))
    (let [doc-ops (psc/q db {:select [:*] :from [:operations]
                             :where [:or [:= :document_id doc]
                                     [:in :id {:select [:op_id] :from [:audit_writes]
                                               :where [:and [:= :target_table "documents"]
                                                       [:= :target_id (str doc)]]}]]
                             :order-by [:ts]})
          vocab-ops (psc/q db {:select [:*] :from [:operations]
                               :where [:in :id {:select [:op_id] :from [:audit_writes]
                                                :where [:= :vocab_layer_id (str vocab)]}]
                               :order-by [:ts]})
          renames (filterv #(= "vocab-item/merge" (:op_type %)) vocab-ops)
          cases [["document" doc-ops (fn [o] (audit/get-document-audit-log db doc nil nil o))]
                 ["vocabulary" vocab-ops (fn [o] (audit/get-vocab-audit-log db vocab nil nil o))]
                 ["vocabulary, renames only" renames
                  (fn [o] (audit/get-vocab-audit-log db vocab nil nil (assoc o :op-types ["vocab-item/merge"])))]]]
      (is (some #(nil? (:document_id %)) (filter #(= "vocab-item/merge" (:op_type %)) doc-ops))
          "a rename with no document of its own is in the document's feed")
      (doseq [[label rows fetch] cases
              order [:desc :asc]
              :let [expected (reference rows (= order :desc))]
              limit [1 2 5 1000]
              step [1 3 250]]
        (testing (str label ", " (name order) ", pages of " limit ", steps of " step)
          (is (seq expected))
          (is (= expected (with-redefs [audit/walk-chunk step] (walk fetch limit order)))))))))

;; ------------------------------------------------------------------
;; Rename and delete under a delegated token
;; ------------------------------------------------------------------

(defn- as-token [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(deftest a-delegated-admin-renames-where-it-deletes
  ;; The vocabulary is user1's, linked to P. The admin is not its maintainer,
  ;; and under a token scoped to P an admin counts as a maintainer there
  ;; (`plaid.rest-api.v1.auth`, Scoped tokens). Rename and delete need the
  ;; same right, so they must answer alike on every route.
  (let [vocab (-> (create-vocab-layer user1-request "Theirs") :body :id)
        p (create-test-project admin-request "Scoped P")
        _ (assert-no-content (link-vocab-to-project admin-request p vocab))
        _ (is (not (some #{"admin@example.com"} (:vocab/maintainers (live-vocab vocab)))))
        [a b c d] (vec (for [f ["a" "b" "c" "d"]] (-> (create-vocab-item user1-request vocab f) :body :id)))
        admin (as-token (auth/issue-delegated-token! db "fake-secret" "admin@example.com" [p]))]
    (testing "rename, one and many"
      (assert-ok (update-vocab-item admin a "a2"))
      (assert-ok (bulk-update-vocab-items admin [{:id b :form "b2"}])))
    (testing "delete, one and many"
      (assert-no-content (delete-vocab-item admin c))
      (assert-no-content (bulk-delete-vocab-items admin [d])))
    (testing "outside the scope, still refused"
      (let [q-vocab (-> (create-vocab-layer user1-request "Elsewhere") :body :id)
            e (-> (create-vocab-item user1-request q-vocab "e") :body :id)]
        (assert-status 403 (update-vocab-item admin e "e2"))
        (assert-status 403 (bulk-update-vocab-items admin [{:id e :form "e2"}]))
        (assert-status 403 (delete-vocab-item admin e))
        (assert-status 403 (bulk-delete-vocab-items admin [e]))))))
