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
  well inside a minute, which is what holds the write lock."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [taoensso.timbre :as log]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call assert-status with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-test-document create-text-layer
                                        create-token-layer-opts create-span-layer create-relation-layer
                                        create-text]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(def ^:private n-words 50000)
(def ^:private per-sentence 15)
(def ^:private limit-ms
  "What a route may spend. They take 3 to 15 s here, the unfixed ones minutes."
  60000)

(defn- id [resp] (-> resp :body :id))

(defn- build!
  "The document, put in with plain inserts: what is timed is the delete
  after it, and the rows' audit history plays no part there."
  []
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

(defn- evict-pool!
  "Close the pool's idle connections, so every later one loads the
  statistics as they are now, as after a restart."
  []
  (.softEvictConnections (.getHikariPoolMXBean db)))

(defn- stale-statistics!
  "Statistics gathered on a tiny document: one relation, three spans."
  []
  (let [p (create-test-project admin-request "Tiny")
        d (create-test-document admin-request p "d")
        tl (id (create-text-layer admin-request p "T"))
        wl (id (create-token-layer-opts admin-request tl "W" {:overlap-mode "non-overlapping"}))
        sl (id (create-span-layer admin-request wl "L"))
        rl (id (create-relation-layer admin-request sl "R"))
        tx (id (create-text admin-request tl d "a b c"))
        toks (for [i [0 2 4]]
               (id (api-call admin-request {:method :post :path "/api/v1/tokens"
                                            :body {:token-layer-id wl :text tx :begin i :end (inc i)}})))
        sps (vec (for [t toks]
                   (id (api-call admin-request {:method :post :path "/api/v1/spans"
                                                :body {:span-layer-id sl :tokens [t] :value "x"}}))))]
    (assert-status 201 (api-call admin-request {:method :post :path "/api/v1/relations"
                                                :body {:layer-id rl :source-id (sps 0) :target-id (sps 1) :value "x"}}))
    (psc/execute! db ["ANALYZE"])))

(defn- fresh-statistics!
  "Statistics of the data as it is, so the fixture's wipe of what is left
  plans well."
  []
  (psc/execute! db ["ANALYZE"])
  (evict-pool!))

(defn- on-stale-statistics
  "Build the document on stale statistics, then `(f fixture)`, timed.
  Returns [response ms]."
  [f]
  (stale-statistics!)
  (try
    (let [fx (build!)
          _ (evict-pool!)
          t (System/nanoTime)
          resp (f fx)]
      [resp (/ (- (System/nanoTime) t) 1e6)])
    (finally (fresh-statistics!))))

(defn- in-document [table doc]
  (:n (psc/q1 db [(str "SELECT count(*) AS n FROM " table " WHERE document_id = ?") (str doc)])))

(deftest a-50000-word-document-is-deleted-in-seconds-on-stale-statistics
  (let [doc (atom nil)
        [resp ms] (on-stale-statistics
                   (fn [fx]
                     (reset! doc (:doc fx))
                     (api-call admin-request {:method :delete :path (str "/api/v1/documents/" (:doc fx))})))]
    (log/warn (format "Deleting a document of 50,000 words on stale statistics: %.0f ms" ms))
    (is (= 204 (:status resp)) (pr-str (:body resp)))
    (is (< ms limit-ms) (str "the delete took " ms " ms"))
    (testing "nothing of the document is left"
      (doseq [t ["tokens" "spans" "relations"]]
        (is (zero? (in-document t @doc)) t)))))

(deftest a-token-layer-under-50000-words-is-deleted-in-seconds-on-stale-statistics
  (let [[resp ms] (on-stale-statistics
                   (fn [{:keys [swl]}]
                     (api-call admin-request {:method :delete :path (str "/api/v1/token-layers/" swl)})))]
    (log/warn (format "Deleting a token layer of 50,000 tokens and 200,000 spans on stale statistics: %.0f ms" ms))
    (is (= 204 (:status resp)) (pr-str (:body resp)))
    (is (< ms limit-ms) (str "the delete took " ms " ms"))))

(deftest a-bulk-span-delete-seeks-the-relations-on-stale-statistics
  (let [[resp ms] (on-stale-statistics
                   (fn [{:keys [spans]}]
                     (api-call admin-request {:method :delete :path "/api/v1/spans/bulk"
                                              :body (vec (take 500 (spans "Lemma")))})))]
    (log/warn (format "Deleting 500 spans among 50,000 relations on stale statistics: %.0f ms" ms))
    (is (= 204 (:status resp)) (pr-str (:body resp)))
    ;; 0.2 s here. Each span scanning every relation twice took seconds.
    (is (< ms 3000) (str "the delete took " ms " ms"))))
