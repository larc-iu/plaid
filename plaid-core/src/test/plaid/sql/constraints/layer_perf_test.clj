(ns plaid.sql.constraints.layer-perf-test
  "What layer constraints add to the time a write holds the lock, on a
  document of 50,000 words shaped like ud's: sentences, words, a syntactic
  word under each word, Form, Lemma, UPOS and XPOS on the syntactic words,
  and a dependency layer on Lemma, with every rule ud declares. One text
  save near the start moves every token after it, which is the heaviest
  structural write there is. `finish!`, the whole of what the rules add,
  must stay under a second there. A 1,000-op batch of span creates on a
  single-span and value-set layer must add under 100 ms."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.sql.constraints.layer :as lc]
            [plaid.sql.text :as text]
            [plaid.sql.token :as token]
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
(def ^:private user "admin@example.com")

(defn- id [resp] (-> resp :body :id))

(defn- ok-ids [result]
  (is (:success result) (pr-str (dissoc result :extra)))
  (:extra result))

(defn- timed-finish
  "Run `f` with `finish!` timed. Returns [total-ms finish-ms]."
  [f]
  (let [spent (atom 0)
        depth (atom 0)
        orig lc/finish!]
    ;; The one-argument finish! calls the two-argument one through the var,
    ;; so only the outermost call is timed.
    (with-redefs [lc/finish! (fn [& args]
                               (let [t (System/nanoTime)
                                     outer? (zero? @depth)]
                                 (swap! depth inc)
                                 (try (apply orig args)
                                      (finally
                                        (swap! depth dec)
                                        (when outer? (swap! spent + (- (System/nanoTime) t)))))))]
      (let [t (System/nanoTime)]
        (f)
        [(/ (- (System/nanoTime) t) 1e6) (/ @spent 1e6)]))))

(defn- build!
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
        ;; extents
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
        ;; The fixture goes in with plain inserts: what is timed is the save
        ;; after it, and the rows' audit history plays no part there.
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
    {:doc doc :txt txt :body body :sl sl :swl swl :span-layers span-layers :deps deps}))

(defn- declare! [kind layer ns cs]
  (assert-status 200 (api-call admin-request {:method :put
                                              :path (str "/api/v1/" kind "-layers/" layer "/constraints/" ns)
                                              :body {:constraints cs}})))

(defn- stale-statistics!
  "Statistics gathered on a tiny document, as an earlier test in the same
  JVM leaves them (`with-clean-db` deletes rows, not `sqlite_stat1`). With
  them SQLite judged the 50,000 spans small and planned same-ancestor's
  whole-document query as a scan per relation: 100 s on the nightly
  (37213142098), where a run of this namespace alone took 0.3 s."
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
  "Statistics of the data as it is, so the fixture's wipe of 50,000 words,
  which the stale ones make take minutes, plans well."
  []
  (psc/execute! db ["ANALYZE"]))

(defn- text-save-with-rules []
  (let [{:keys [txt body sl swl span-layers deps]} (build!)
        save! (fn [new-body] (is (:success (text/update-body db txt new-body user))))
        [plain-ms plain-finish] (timed-finish #(save! (str "x" body)))]
    (declare! "token" swl "ud" [{:type "coextensive"}])
    (doseq [[n l] span-layers]
      (declare! "span" l "ud" (cond-> [{:type "single-span"}]
                                (= n "UPOS") (conj {:type "value-set" :values ["NOUN" "VERB"]}))))
    (declare! "relation" deps "ud" [{:type "acyclic" :self-loops true}
                                    {:type "max-in-degree" :max 1}
                                    {:type "same-ancestor" :token-layer sl}
                                    {:type "value-set" :values ["root" "dep"] :delimiters ":" :parts "first"}])
    (let [[ruled-ms ruled-finish] (timed-finish #(save! (str "xy" body)))]
      (log/warn (format "50,000 words, one edit at the start: %.0f ms without rules (finish! %.0f ms), %.0f ms with (finish! %.0f ms)"
                        plain-ms plain-finish ruled-ms ruled-finish))
      (is (< (- ruled-finish plain-finish) 1000)
          (str "the rules added " (- ruled-finish plain-finish) " ms to a text save")))))

(deftest a-text-save-on-50000-words-spends-under-a-second-on-the-rules
  (stale-statistics!)
  (try
    (text-save-with-rules)
    (finally (fresh-statistics!))))

(deftest a-1000-op-batch-spends-under-100-ms-on-the-rules
  (let [proj (create-test-project admin-request "Batch")
        doc (create-test-document admin-request proj "D")
        tl (id (create-text-layer admin-request proj "T"))
        wl (id (create-token-layer-opts admin-request tl "Word" {:overlap-mode "non-overlapping"}))
        gloss (id (create-span-layer admin-request wl "Gloss"))
        body (str/join " " (repeat 1000 "ab"))
        txt (id (create-text admin-request tl doc body))
        toks (ok-ids (token/bulk-create db (mapv (fn [i] {:token/text txt :token/layer wl
                                                          :token/begin (* 3 i) :token/end (+ 2 (* 3 i))})
                                                 (range 1000))
                                        user))
        ops (vec (for [t toks] {:path "/api/v1/spans" :method "POST"
                                :body {:span-layer-id gloss :tokens [t] :value "N"}}))
        run! (fn [] (assert-status 200 (api-call admin-request {:method :post :path "/api/v1/batch" :body ops})))]
    (declare! "span" gloss "igt" [{:type "single-span"} {:type "value-set" :values ["N" "V"]}])
    (let [[total-ms finish-ms] (timed-finish run!)]
      (log/warn (format "1,000 span creates in one batch: %.0f ms, finish! %.0f ms" total-ms finish-ms))
      (is (< finish-ms 100) (str "the rules added " finish-ms " ms to the batch")))))
