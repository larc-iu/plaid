(ns plaid.sql.delete-perf-test
  "The delete routes on a document of 50,000 words shaped like ud's
  (sentences, words, a syntactic word under each word, Form, Lemma, UPOS and
  XPOS spans on the syntactic words, a dependency on every Lemma), on
  planner statistics gathered while the tables held a row or two, as an
  earlier test in the same JVM or a young install leaves them.

  On such statistics SQLite plans the FK cascade of every deleted span as a
  scan of all relations, and of every IN list as a scan of the table: a
  token layer's delete took minutes. A document's delete was refused with a
  500 on any statistics, since one statement listed all 200,000 of its spans
  twice and passed SQLite's statement length limit. Each delete must finish
  well inside a minute, which is what holds the write lock. A delete of the
  document or a layer is timed against the same on a document of 5,000
  words: a scan per row makes the big one a hundred times as slow, where it
  should be ten. A bulk delete of spans is timed against another of the same
  size on fresh statistics."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [taoensso.timbre :as log]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call assert-status with-clean-db]]
            [plaid.test-helpers :as h :refer [evict-pool! id stale-statistics! create-test-project create-test-document create-text-layer
                                              create-token-layer-opts create-span-layer create-relation-layer
                                              create-text]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(def ^:private n-words 50000)
(def ^:private few-words 5000)
(def ^:private per-sentence 15)

(defn- build!
  "The document, put in with plain inserts: what is timed is the delete
  after it, and the rows' audit history plays no part there."
  [n-words]
  (let [words (mapv #(str "w" (mod % 97)) (range n-words))
        sentences (partition-all per-sentence words)
        body (str/join "\n" (map #(str (str/join " " %) " .") sentences))
        proj (create-test-project admin-request "Perf")
        doc (create-test-document admin-request proj "D")
        tl (id (create-text-layer admin-request proj "T"))
        sl (id (create-token-layer-opts admin-request tl "Sentence" {:overlap-mode "partitioning"}))
        wl (id (create-token-layer-opts admin-request tl "Word" {:overlap-mode "non-overlapping"
                                                                 :parent-token-layer-id sl}))
        swl (id (create-token-layer-opts admin-request tl "Syntactic word" {:parent-token-layer-id wl}))
        span-layers (into {} (for [n ["Form" "Lemma" "UPOS" "XPOS"]]
                               [n (id (create-span-layer admin-request swl n))]))
        deps (id (create-relation-layer admin-request (span-layers "Lemma") "Deps"))
        txt (id (create-text admin-request tl doc body))
        [word-extents sentence-extents]
        (loop [ss sentences p 0 ws [] sx []]
          (if-let [s (first ss)]
            (let [[ws* p*] (reduce (fn [[acc p] w] [(conj acc [p (+ p (count w))]) (+ p (count w) 1)])
                                   [ws p] s)
                  end (+ p* 1)]
              ;; the sentence covers its words, the " ." and the newline after
              (recur (rest ss) (inc end) ws* (conj sx [p (min (inc end) (count body))])))
            [ws sx]))
        sentence-extents (assoc-in sentence-extents [(dec (count sentence-extents)) 1] (count body))
        doc-id (str doc)
        insert! (fn [table rows]
                  (doseq [chunk (partition-all 4000 rows)]
                    (psc/execute! db {:insert-into table :values (vec chunk)})))
        mk (fn [layer extents]
             (let [rows (mapv (fn [[b e]] {:id (str (psc/new-uuid)) :text_id (str txt) :token_layer_id (str layer)
                                           :document_id doc-id :begin b :end_ e})
                              extents)]
               (insert! :tokens rows)
               (mapv :id rows)))
        _ (mk sl sentence-extents)
        _ (mk wl word-extents)
        sws (mk swl word-extents)
        spans (into {} (for [[n l] span-layers]
                         (let [rows (vec (map-indexed (fn [i _] {:id (str (psc/new-uuid)) :span_layer_id (str l)
                                                                 :document_id doc-id
                                                                 :value (psc/write-json (if (= n "UPOS") "NOUN" (words i)))})
                                                      sws))]
                           (insert! :spans rows)
                           (insert! :span_tokens (map (fn [r t] {:span_id (:id r) :token_id t :order_idx 0}) rows sws))
                           [n (mapv :id rows)])))
        lemma (spans "Lemma")
        ;; each word's head is the sentence's first word, which heads itself
        heads (for [i (range n-words)
                    :let [root (* per-sentence (quot i per-sentence))]]
                {:id (str (psc/new-uuid)) :relation_layer_id (str deps) :document_id doc-id
                 :source_span_id (lemma root) :target_span_id (lemma i)
                 :value (psc/write-json (if (= i root) "root" "dep"))})]
    (insert! :relations heads)
    {:doc doc :swl swl :spans spans}))

(defn- fresh-statistics!
  "Statistics of the data as it is, so the fixture's wipe of what is left
  plans well."
  []
  (psc/execute! db ["ANALYZE"])
  (evict-pool!))

(defn- on-stale-statistics
  "Build the document of `n` words on stale statistics, then
  `(f fixture)`, timed. Returns [response ms]."
  [n f]
  (stale-statistics!)
  (try
    (let [fx (build! n)
          _ (evict-pool!)
          t (System/nanoTime)
          resp (f fx)]
      [resp (/ (- (System/nanoTime) t) 1e6)])
    (finally (fresh-statistics!))))

(defn- small-then-big
  "`(f fixture)` timed on stale statistics over 5,000 words, then over
  50,000, with the database cleaned between. Returns [the big one's
  response, the big one's ms, the small one's ms], having checked the small
  one answered `status`."
  [status f]
  (let [[small-resp small-ms] (with-clean-db #(on-stale-statistics few-words f))
        [resp ms] (on-stale-statistics n-words f)]
    (is (= status (:status small-resp)) (pr-str (:body small-resp)))
    [resp ms small-ms]))

(defn- in-document [table doc]
  (:n (psc/q1 db [(str "SELECT count(*) AS n FROM " table " WHERE document_id = ?") (str doc)])))

(deftest a-50000-word-document-is-deleted-in-seconds-on-stale-statistics
  (let [doc (atom nil)
        [resp ms small-ms] (small-then-big
                            204
                            (fn [fx]
                              (reset! doc (:doc fx))
                              (api-call admin-request {:method :delete :path (str "/api/v1/documents/" (:doc fx))})))]
    (log/warn (format "Deleting a document of 50,000 words on stale statistics: %.0f ms (5,000 words: %.0f ms)" ms small-ms))
    (is (= 204 (:status resp)) (pr-str (:body resp)))
    (h/within-factor-of 30 small-ms ms {:floor-ms 100 :label "the document's delete"})
    (testing "nothing of the document is left"
      (doseq [t ["tokens" "spans" "relations"]]
        (is (zero? (in-document t @doc)) t)))))

(deftest a-token-layer-under-50000-words-is-deleted-in-seconds-on-stale-statistics
  (let [[resp ms small-ms] (small-then-big
                            204
                            (fn [{:keys [swl]}]
                              (api-call admin-request {:method :delete :path (str "/api/v1/token-layers/" swl)})))]
    (log/warn (format "Deleting a token layer of 50,000 tokens and 200,000 spans on stale statistics: %.0f ms (5,000 words: %.0f ms)" ms small-ms))
    (is (= 204 (:status resp)) (pr-str (:body resp)))
    (h/within-factor-of 30 small-ms ms {:floor-ms 100 :label "the token layer's delete"})))

(deftest a-bulk-span-delete-seeks-the-relations-on-stale-statistics
  ;; 0.2 s here, about the same as 500 others of the same document take on
  ;; statistics of the data. Each span scanning every relation twice took
  ;; seconds on stale statistics, and as little as the rest on fresh ones.
  (stale-statistics!)
  (try
    (let [{:keys [spans]} (build! n-words)
          lemma (spans "Lemma")
          delete! (fn [ids]
                    (h/timed #(api-call admin-request {:method :delete :path "/api/v1/spans/bulk"
                                                       :body (vec ids)})))
          _ (evict-pool!)
          [resp ms] (delete! (take 500 lemma))
          _ (fresh-statistics!)
          [fresh-resp fresh-ms] (delete! (take 500 (drop 500 lemma)))]
      (log/warn (format "Deleting 500 spans among 50,000 relations on stale statistics: %.0f ms (on fresh ones: %.0f ms)"
                        ms fresh-ms))
      (is (= 204 (:status resp)) (pr-str (:body resp)))
      (is (= 204 (:status fresh-resp)) (pr-str (:body fresh-resp)))
      (h/within-factor-of 8 fresh-ms ms {:floor-ms 100 :label "500 spans' delete on stale statistics"}))
    (finally (fresh-statistics!))))
