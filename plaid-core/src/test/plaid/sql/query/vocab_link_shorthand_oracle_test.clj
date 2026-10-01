(ns plaid.sql.query.vocab-link-shorthand-oracle-test
  "The `vocab-link` shorthand judged against an evaluator that never goes near
  the compiler. Random documents in two projects share one vocabulary and one
  of them has a second. Links cover one to three tokens, an entry reaches a
  token through several links, and links are deleted, trimmed by a token
  delete, moved by a token merge, copied with a document and put back by a
  restore. Random queries built on the shorthand (aggregates, ids and counts,
  `not`, `or`, spans, relations, a second shorthand, a named link, limits) run
  as an admin, as a reader of one project, and as an admin scoped to that
  project.

  The oracle here reads the raw tables and evaluates the clauses by brute force,
  so a match is a binding of the variables and nothing else. Each query is also
  run with the compiler's DISTINCT forced on, which is what the compiler did for
  every shorthand query before it learned to drop it (54811bd2). No query here
  orders its rows (an aggregate return refuses `order-by`), so rows come in
  whatever order the plan gives and a limit takes an arbitrary slice: the two
  runs must return the same rows as a multiset, or under a limit the same
  number of rows, all of which the oracle must hold."
  (:require [clojure.set :as set]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request api-call reset-db!]]
            [plaid.test-helpers :as h]
            [plaid.sql.common :as psc]
            [plaid.query.ast :as ast]
            [plaid.sql.query.compile :as qc]
            [plaid.sql.query.resolve :as qr]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (some-> r :body :id str))
(defn- ok? [r] (< (:status r) 300))

(defn- sid [x] (some-> x str))

(defn- pick [^java.util.Random rnd xs] (nth xs (.nextInt rnd (count xs))))

(defn- pick-distinct [^java.util.Random rnd xs k]
  (let [al (java.util.ArrayList. ^java.util.Collection (vec xs))]
    (java.util.Collections/shuffle al rnd)
    (vec (take k al))))

(defn- chance [^java.util.Random rnd p] (< (.nextDouble rnd) p))

;; ---------------------------------------------------------------------------
;; Data
;; ---------------------------------------------------------------------------

(defn- build-doc! [^java.util.Random rnd {:keys [pid txtl words morphs pos dep]} items dname]
  (let [d (sid (h/create-test-document admin-request pid dname))
        n (+ 3 (.nextInt rnd 5))
        tx (id (h/create-text admin-request txtl d (apply str (repeat n "ab "))))
        ws (vec (for [j (range n)]
                  (id (h/create-token admin-request words tx (* 3 j) (+ 2 (* 3 j))))))
        ms (vec (for [j (range n) k (range (inc (.nextInt rnd 2)))]
                  (id (h/create-token admin-request morphs tx (* 3 j) (+ 2 (* 3 j)) k))))
        links (atom [])
        link! (fn [item toks]
                (let [r (h/create-vocab-link admin-request item toks)]
                  (when (ok? r) (swap! links conj {:id (id r) :item item :tokens toks}))))]
    (let [spans (vec (keep id (concat
                               (for [w ws _ (range (.nextInt rnd 2))]
                                 (h/create-span admin-request pos [w] (pick rnd ["N" "V"])))
                               (for [_ ws :when (chance rnd 0.3)]
                                 (h/create-span admin-request pos (pick-distinct rnd ws 2) "X")))))]
      (when (< 1 (count spans))
        (dotimes [_ (.nextInt rnd 4)]
          (let [[a b] (pick-distinct rnd spans 2)]
            (h/create-relation admin-request dep a b "dep")))))
    (dotimes [_ (+ 3 (.nextInt rnd 8))]
      (let [layer (if (.nextBoolean rnd) ws ms)
            k (min (count layer) (inc (.nextInt rnd 3)))]
        (link! (pick rnd items) (pick-distinct rnd layer k))))
    ;; the same entry again on some of a link's tokens, through another link
    (dotimes [_ (+ 1 (.nextInt rnd 4))]
      (let [{:keys [item tokens]} (pick rnd @links)]
        (link! item (pick-distinct rnd tokens (inc (.nextInt rnd (count tokens)))))))
    ;; a bulk create with the same entry twice on one word
    (when (chance rnd 0.5)
      (let [item (pick rnd items) w (pick rnd ws)]
        (h/bulk-create-vocab-links admin-request [{:vocab-item item :tokens [w]}
                                                  {:vocab-item item :tokens [w (pick rnd ws)]}])))
    (let [before (do (Thread/sleep 5) (java.time.Instant/now))]
      (Thread/sleep 5)
      (when (chance rnd 0.7)
        (h/delete-vocab-link admin-request (:id (pick rnd @links))))
      ;; a merge moves the right word's links onto the left one
      (when (chance rnd 0.6)
        (let [j (.nextInt rnd (dec n))]
          (h/merge-tokens admin-request (ws j) (ws (inc j)))))
      ;; a delete trims the links over the morph
      (when (chance rnd 0.5)
        (h/delete-token admin-request (pick rnd ms)))
      (when (chance rnd 0.3)
        (api-call admin-request {:method :post
                                 :path (str "/api/v1/documents/" d "/restore?as-of=" before)}))
      (when (chance rnd 0.3)
        (api-call admin-request {:method :post :path (str "/api/v1/documents/" d "/copy")
                                 :body {:name (str dname " copy")}})))))

(defn- build-project! [rnd pname vls items]
  (let [pid (h/create-test-project admin-request pname)
        txtl (id (h/create-text-layer admin-request pid "text"))
        words (id (h/create-token-layer admin-request txtl "words"))
        morphs (id (h/create-token-layer admin-request txtl "morphs" "any"))
        pos (id (h/create-span-layer admin-request words "pos"))
        dep (id (h/create-relation-layer admin-request pos "dep"))
        pid (sid pid)
        p {:pid pid :txtl txtl :words words :morphs morphs :pos pos :dep dep}]
    (doseq [vl vls] (h/link-vocab-to-project admin-request pid vl))
    (doseq [i (range 2)] (build-doc! rnd p items (str pname " d" i)))
    p))

(defn- build! [rnd seed]
  (let [vl1 (id (h/create-vocab-layer admin-request (str "shared " seed)))
        vl2 (id (h/create-vocab-layer admin-request (str "A only " seed)))
        items1 (vec (for [i (range 4)] (id (h/create-vocab-item admin-request vl1 (str "s" i)))))
        items2 (vec (for [i (range 3)] (id (h/create-vocab-item admin-request vl2 (str "a" i)))))
        a (build-project! rnd (str "A" seed) [vl1 vl2] (into items1 items2))
        b (build-project! rnd (str "B" seed) [vl1] items1)]
    (h/add-project-reader admin-request (:pid a) "user1@example.com")
    {:vl1 vl1 :vl2 vl2 :a a :b b}))

;; ---------------------------------------------------------------------------
;; The oracle: the raw tables and a brute-force evaluator
;; ---------------------------------------------------------------------------

(defn- rows
  "Rows with every id as a string, as the query results and the REST bodies
  carry them."
  [sql]
  (walk/postwalk #(if (uuid? %) (str %) %) (psc/q db sql)))

(defn- load-world []
  (let [by-id (fn [rs f] (into {} (map (juxt :id f)) rs))
        members (fn [rs k v] (reduce (fn [m r] (update m (k r) (fnil conj #{}) (v r))) {} rs))
        vlt (rows {:select [:vocab_link_id :token_id] :from [:vocab_link_tokens]})
        links (rows {:select [:id :vocab_item_id :document_id] :from [:vocab_links]})
        link-toks (members vlt :vocab_link_id :token_id)
        link-item (by-id links :vocab_item_id)]
    {:live-projects (set (map :id (rows {:select [:id] :from [:projects] :where [:= :deleted_at nil]})))
     :tok (by-id (rows {:select [:id :token_layer_id :begin] :from [:tokens]}) identity)
     :tl-proj (by-id (rows {:select [:id :project_id] :from [:token_layers]}) :project_id)
     :span-layer (by-id (rows {:select [:id :span_layer_id] :from [:spans]}) :span_layer_id)
     :sl-proj (by-id (rows {:select [:id :project_id] :from [:span_layers]}) :project_id)
     :rel (by-id (rows {:select [:id :relation_layer_id :source_span_id :target_span_id] :from [:relations]}) identity)
     :rl-proj (by-id (rows {:select [:id :project_id] :from [:relation_layers]}) :project_id)
     :span-toks (members (rows {:select [:span_id :token_id] :from [:span_tokens]}) :span_id :token_id)
     :item-vl (by-id (rows {:select [:id :vocab_layer_id] :from [:vocab_items]}) :vocab_layer_id)
     :grants (members (rows {:select [:project_id :vocab_layer_id] :from [:project_vocabs]})
                      :vocab_layer_id :project_id)
     :doc-proj (by-id (rows {:select [:id :project_id] :from [:documents]}) :project_id)
     :link-item link-item
     :link-doc (by-id links :document_id)
     :link-toks link-toks
     :tok-items (reduce (fn [m {:keys [vocab_link_id token_id]}]
                          (update m token_id (fnil conj #{}) (link-item vocab_link_id)))
                        {} vlt)
     :twice (count (filter #(> (val %) 1)
                           (frequencies (for [{:keys [vocab_link_id token_id]} vlt]
                                          [token_id (link-item vocab_link_id)]))))
     :repeated (rows {:select [:vocab_link_id :token_id] :from [:vocab_link_tokens]
                      :group-by [:vocab_link_id :token_id] :having [:> :%count.* 1]})}))

(defn- kind-of [v]
  (let [n (name v)]
    (cond (str/starts-with? n "?tl") :token-layer
          (str/starts-with? n "?t") :token
          (str/starts-with? n "?v") :vocab
          (str/starts-with? n "?s") :span
          (str/starts-with? n "?l") :link
          (str/starts-with? n "?r") :relation
          (str/starts-with? n "?b") :scalar)))

(defn- domain [w scope kind]
  (let [in? #(contains? scope %)]
    (case kind
      :vocab (for [[i vl] (:item-vl w) :when (some in? ((:grants w) vl))] i)
      :token (for [[t {:keys [token_layer_id]}] (:tok w) :when (in? ((:tl-proj w) token_layer_id))] t)
      :token-layer (for [[l p] (:tl-proj w) :when (in? p)] l)
      :span (for [[s l] (:span-layer w) :when (in? ((:sl-proj w) l))] s)
      :link (for [[l d] (:link-doc w) :when (in? ((:doc-proj w) d))] l)
      :relation (for [[r {:keys [relation_layer_id]}] (:rel w) :when (in? ((:rl-proj w) relation_layer_id))] r))))

(defn- qvar? [x] (and (string? x) (str/starts-with? x "?")))

(declare solve)

(defn- check
  "Bindings extending `b` that satisfy `clause`, whose entity vars are all bound
  in `b` already (its scalar vars may still be unbound)."
  [w scope b clause]
  (let [[head x y] clause
        val (fn [t] (if (qvar? t) (get b t) t))]
    (case head
      "vocab" (let [v (val x) {:strs [layer]} y]
                (when (or (nil? layer) (= layer ((:item-vl w) v))) [b]))
      "token" (let [{:keys [token_layer_id begin]} ((:tok w) (val x))
                    {:strs [layer] bv "begin"} y
                    bind (fn [b k actual]
                           (cond (nil? k) b
                                 (and (map? k) (contains? b (k "var")))
                                 (when (= actual (get b (k "var"))) b)
                                 (map? k) (assoc b (k "var") actual)
                                 (qvar? k) (when (= actual (get b k)) b)
                                 :else (when (= k actual) b)))]
                (some-> b (bind layer token_layer_id) (bind bv begin) vector))
      "token-layer" [b]
      "span" (let [{:strs [layer]} y]
               (when (or (nil? layer) (= layer ((:span-layer w) (val x)))) [b]))
      "vocab-link" (when (contains? ((:tok-items w) (val x)) (val y)) [b])
      "relation" [b]
      "source" (when (= (:source_span_id ((:rel w) (val x))) (val y)) [b])
      "target" (when (= (:target_span_id ((:rel w) (val x))) (val y)) [b])
      "covers" (when (contains? ((:span-toks w) (val x)) (val y)) [b])
      "link" (when (= ((:link-item w) (val x)) (val (get y "item"))) [b])
      "link-token" (when (contains? ((:link-toks w) (val x)) (val y)) [b])
      "not" (when (empty? (solve w scope [b] (rest clause))) [b]))))

(defn- clause-entity-vars [clause]
  (let [[head & args] clause]
    (case head
      "not" []
      ("vocab" "token" "token-layer" "span" "relation") [(first args)]
      "link" (filter qvar? [(first args) (get (second args) "item")])
      ;; a token clause's layer var is an entity var too
      (filter qvar? args))))

(defn- solve
  "Every binding extending one of `bs` that satisfies all `clauses`, entity vars
  enumerated from their in-scope domains."
  [w scope bs clauses]
  (reduce (fn [bs clause]
            (let [evs (concat (clause-entity-vars clause)
                              (when (= "token" (first clause))
                                (let [l (get (nth clause 2) "layer")] (when (qvar? l) [l]))))]
              (mapcat (fn [b]
                        (let [free (remove #(contains? b %) (distinct evs))
                              exts (reduce (fn [acc v]
                                             (for [e acc x (domain w scope (kind-of v))] (assoc e v x)))
                                           [b] free)]
                          (mapcat #(check w scope % clause) exts)))
                      bs)))
          bs clauses))

(defn- branches
  "The alternatives of a where clause with at most one top-level `or`."
  [where]
  (if-let [o (first (filter #(= "or" (first %)) where))]
    (let [rest* (remove #(= o %) where)]
      (for [br (rest o)] (vec (concat rest* br))))
    [where]))

(defn- bound-vars
  "The variables a branch binds (not the ones only inside a `not`)."
  [clauses]
  (set (for [c clauses :when (not= "not" (first c))
             x (rest c)
             v (cond (qvar? x) [x]
                     (map? x) (keep #(cond (qvar? %) % (map? %) (% "var")) (vals x)))]
         v)))

(defn- common-vars [where]
  (apply set/intersection (map bound-vars (branches where))))

(defn- matches
  "The distinct matches of `where` for `scope`, each a map of the vars every
  alternative binds."
  [w scope where]
  (let [cv (common-vars where)]
    (set (for [br (branches where)
               b (solve w scope [{}] br)]
           (select-keys b cv)))))

(defn- oracle [w scope {:strs [where return find]}]
  (let [ms (matches w scope where)]
    (cond
      (map? return)
      (let [{:strs [group aggregates]} return
            groups (group-by (fn [m] (mapv m group)) ms)
            agg (fn [ms [op src]]
                  (let [xs (map #(get % src) ms)]
                    (case op
                      "count" (count ms)
                      "sum" (when (seq xs) (reduce + xs))
                      "min" (when (seq xs) (reduce min xs))
                      "max" (when (seq xs) (reduce max xs)))))
            groups (if (and (empty? group) (empty? groups)) {[] []} groups)]
        {:rows (set (for [[k ms] groups] (into k (map #(agg ms %) aggregates))))})
      (= return "count") {:count (count (set (map #(mapv % find) ms)))}
      :else {:rows (set (map #(mapv % find) ms))})))

;; ---------------------------------------------------------------------------
;; Random queries on the shorthand
;; ---------------------------------------------------------------------------

(defn- gen-query [^java.util.Random rnd {:keys [vl1 vl2 a]}]
  (let [vocab-c ["vocab" "?v" (pick rnd [{"layer" vl1} {"layer" vl2} {}])]
        one-branch? (chance rnd 0.15)
        base (if one-branch?
               [vocab-c ["token" "?t" {}]
                ["or" [["vocab-link" "?t" "?v"]] [["link" "?l" {"item" "?v"}] ["link-token" "?l" "?t"]]]]
               [vocab-c ["vocab-link" "?t" "?v"]])
        where (cond-> base
                (chance rnd 0.5)
                (into (pick rnd [[["token" "?t" {"layer" "?tl"}] ["token-layer" "?tl" {}]]
                                 [["token" "?t" {"layer" (:words a)}]]
                                 [["token" "?t" {"begin" {"var" "?b"}}]]
                                 [["token" "?t" {"layer" "?tl" "begin" {"var" "?b"}}] ["token-layer" "?tl" {}]]]))
                (chance rnd 0.35)
                (into (pick rnd [[["vocab" "?v2" {}] ["vocab-link" "?t" "?v2"]]
                                 [["vocab-link" "?t2" "?v"]]
                                 [["vocab-link" "?t" "?v"]]]))
                (chance rnd 0.3)
                (into (pick rnd [[["span" "?s" {}] ["covers" "?s" "?t"]]
                                 [["span" "?s" {"layer" (:pos a)}] ["covers" "?s" "?t"]]]))
                (and (not one-branch?) (chance rnd 0.2))
                (into [["link" "?l" {"item" "?v"}] ["link-token" "?l" "?t"]])
                (chance rnd 0.25)
                (into (pick rnd [[["span" "?s4" {}] ["covers" "?s4" "?t"] ["relation" "?r" {}] ["source" "?r" "?s4"]]
                                 [["span" "?s4" {}] ["covers" "?s4" "?t"] ["relation" "?r" {}] ["target" "?r" "?s4"]
                                  ["span" "?s5" {}] ["source" "?r" "?s5"] ["covers" "?s5" "?t5"] ["vocab-link" "?t5" "?v"]]
                                 [["span" "?s4" {}] ["covers" "?s4" "?t"]
                                  ["not" ["relation" "?r9" {}] ["source" "?r9" "?s4"]]]]))
                (chance rnd 0.3)
                (conj (pick rnd [["not" ["span" "?s9" {}] ["covers" "?s9" "?t"]]
                                 ["not" ["vocab" "?v9" {"layer" vl2}] ["vocab-link" "?t" "?v9"]]
                                 ["not" ["vocab-link" "?t9" "?v"] ["token" "?t9" {"layer" (:morphs a)}]]]))
                (and (not one-branch?) (chance rnd 0.2))
                (conj (pick rnd [["or" [["span" "?s8" {}] ["covers" "?s8" "?t"]]
                                  [["token" "?t" {"layer" (:morphs a)}]]]
                                 ["or" [["vocab" "?v7" {"layer" vl1}] ["vocab-link" "?t" "?v7"]]
                                  [["vocab" "?v7" {"layer" vl2}] ["vocab-link" "?t" "?v7"]]]])))
        cv (sort (common-vars where))
        entity-cv (vec (remove #(= :scalar (kind-of %)) cv))
        subset (fn [xs] (vec (filter (fn [_] (.nextBoolean rnd)) xs)))
        mode (pick rnd [:agg :agg :agg :agg :ids :count])
        limit (when (chance rnd 0.3) (inc (.nextInt rnd 4)))]
    (case mode
      :agg (let [b? (some #{"?b"} cv)]
             (cond-> {"where" where
                      "return" {"group" (subset cv)
                                "aggregates" (into [["count"]]
                                                   (when b? (subset [["sum" "?b"] ["min" "?b"] ["max" "?b"]])))}}
               limit (assoc "limit" limit)))
      :ids (cond-> {"where" where
                    "find" (let [f (subset entity-cv)] (if (seq f) f [(first entity-cv)]))}
             limit (assoc "limit" limit))
      :count {"where" where "find" entity-cv "return" "count"})))

;; ---------------------------------------------------------------------------
;; Running
;; ---------------------------------------------------------------------------

(defn- norm [x]
  (cond (nil? x) nil
        (and (number? x) (== x (Math/rint (double x)))) (long x)
        (number? x) (double x)
        :else (str x)))

(defn- run [user body]
  (let [r (qe/run db user body)]
    (if (= :count (:return r))
      {:count (:count r)}
      {:rows (mapv #(mapv norm %) (:results r)) :truncated (:truncated r)})))

(defn- run-distinct [user body]
  (with-redefs [qc/distinct-redundant? (fn [& _] false)]
    (run user body)))

(defn- elided?
  "Whether the query's branches all compile without the DISTINCT."
  [user body]
  (every? #(contains? (qc/compile-query (qr/resolve-query db user %)) :select)
          (ast/expand body)))

(defn- same-answer?
  "Whether two runs of one unordered query agree. Rows come in plan order, and
  dropping the DISTINCT changes the plan, so they are compared as a multiset (a
  duplicated row still counts). Under a limit each run may take a different
  slice, so only its size and `:truncated` are compared here and `judge` holds
  every row against the oracle."
  [lim got kept]
  (cond
    (:count got) (= got kept)
    lim (and (= (:truncated got) (:truncated kept))
             (= (count (:rows got)) (count (:rows kept))))
    :else (and (= (:truncated got) (:truncated kept))
               (= (frequencies (:rows got)) (frequencies (:rows kept))))))

(defn- judge
  "Nil when the engine agrees with the forced-DISTINCT run and the oracle,
  otherwise a description of the difference."
  [w scope user body engine]
  (let [got (engine user body)
        kept (run-distinct user body)
        want (oracle w scope body)
        lim (get body "limit")]
    (cond
      (not (same-answer? lim got kept)) {:problem :differs-from-distinct :got got :distinct kept}
      (:count want) (when (not= (:count want) (:count got)) {:problem :count :got got :want want})
      (and lim (map? (get body "return")))
      (let [rows (:rows got)]
        (when-not (and (every? (:rows want) rows)
                       (= (count rows) (min lim (count (:rows want)))))
          {:problem :limited-rows :got got :want want}))
      lim (when-not (and (every? (:rows want) (:rows got))
                         (= (count (:rows got)) (min lim (count (:rows want)))))
            {:problem :limited-rows :got got :want want})
      :else (when (not= (:rows want) (set (:rows got)))
              {:problem :rows :got got :want want}))))

(defn campaign
  "Build `seeds` datasets and run `per-seed` random queries on each as three
  readers. Returns {:checked n :failures [...] :elided n :repeated [...]}.
  `engine` runs a query as a user (a later compiler can be swapped in)."
  ([seeds per-seed] (campaign seeds per-seed run))
  ([seeds per-seed engine]
   (reduce
    (fn [acc seed]
      (let [rnd (java.util.Random. seed)
            ctx (build! rnd seed)
            w (load-world)
            a (get-in ctx [:a :pid])
            b (get-in ctx [:b :pid])
            readers [["admin@example.com" #{a b} identity]
                     ["user1@example.com" #{a} identity]
                     ["admin@example.com" #{a} #(assoc % "scope" {"project-ids" [a]})]]
            acc (update acc :repeated into (:repeated w))
            acc (update acc :twice + (:twice w))]
        (assert (= (:live-projects w) #{a b}))
        (let [acc (reduce
                   (fn [acc _]
                     (let [body (gen-query rnd ctx)]
                       (reduce (fn [acc [user scope f]]
                                 (let [body (f body)
                                       failure (try (judge w scope user body engine)
                                                    (catch Exception e {:problem :threw :message (ex-message e)
                                                                        :data (ex-data e)}))]
                                   (cond-> (update acc :checked inc)
                                     (and (map? (get body "return")) (elided? user body))
                                     (update :elided inc)
                                     failure (update :failures conj (assoc failure :seed seed :user user :body body)))))
                               acc readers)))
                   acc (range per-seed))]
          (reset-db! db)
          acc)))
    {:checked 0 :elided 0 :failures [] :repeated [] :twice 0}
    seeds)))

(deftest the-shorthand-answers-what-the-oracle-answers
  (let [{:keys [checked elided failures repeated twice]} (campaign (range 8) 40)]
    (println "shorthand oracle:" checked "queries," elided "without the DISTINCT,"
             twice "token and entry pairs reached through two links")
    (testing "no write path left a link naming one token twice"
      (is (empty? repeated)))
    (testing "the data holds entries that reach a token through two links"
      (is (< 20 twice)))
    (is (= (* 8 40 3) checked))
    (testing "the guard is exercised"
      (is (< 200 elided)))
    (is (empty? failures) (pr-str (take 3 failures)))))

(defn- run-in-another-order
  "`run` as a different plan might answer: the rows reversed, and under a limit
  the slice taken from the other end."
  [user body]
  (let [lim (get body "limit")
        r (run user (dissoc body "limit"))]
    (if-not (:rows r)
      r
      (let [rows (vec (rseq (:rows r)))]
        (if lim
          {:rows (vec (take lim rows)) :truncated (> (count rows) lim)}
          (assoc r :rows rows))))))

(deftest the-judge-ignores-row-order
  ;; Release run 36799800120 failed on a grouped count whose elided and
  ;; DISTINCT runs held the same 17 rows with two of them in other places.
  (let [{:keys [checked failures]} (campaign [0] 40 run-in-another-order)]
    (is (= (* 40 3) checked))
    (is (empty? failures) (pr-str (take 3 failures)))))

(deftest the-oracle-sees-a-shorthand-without-its-guard
  (with-redefs [qc/first-link-only (fn [& _] nil)]
    (let [{:keys [failures]} (campaign [3] 40)]
      (is (seq failures)))))
