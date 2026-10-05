(ns plaid.sql.cascade-routes-stale-test
  "Every route that deletes many cascade parents in one transaction, on
  planner statistics taken while each cascade child held one row.

  On such statistics SQLite plans the cascade of each deleted parent as a
  scan of the whole child table. Here 1,000 parents are deleted while the
  child tables hold 150,000 rows of another document, so a route that does
  not make its statistics safe first (`plaid.sql.cascade-statistics/prepare!`)
  visits hundreds of millions of rows and takes seconds, where one that does
  takes a fraction of one. Unlinking a vocabulary from a project took 9 s at
  16,000 links, minutes at the largest vocabulary on prod."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call assert-status with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-test-document create-text-layer
                                        create-token-layer-opts create-span-layer create-relation-layer
                                        create-text create-vocab-layer create-vocab-item
                                        link-vocab-to-project]])
  (:import (java.time Instant)))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(def ^:private n-parents 1000)
(def ^:private bystanders 150000)
(def ^:private limit-ms
  "A route here takes 0.05 to 1.2 s (the repair's checks are most of its
  time). Without `prepare!` each took 8 to 32 s."
  4000)

(defn- id [resp] (-> resp :body :id))
(defn- ids [resp] (assert-status 201 resp) (-> resp :body :ids))
(defn- call [method path & [body]]
  (api-call admin-request (cond-> {:method method :path path} body (assoc :body body))))

(defn- evict-pool! []
  (.softEvictConnections (.getHikariPoolMXBean db)))

(defn- annotated-document
  "A document of `n` one-letter words with a token layer, a span layer
  and a relation layer on it, and a vocabulary linked to the project."
  [proj vocab name n]
  (let [doc (create-test-document admin-request proj name)
        tl (id (create-text-layer admin-request proj (str name " T")))
        wl (id (create-token-layer-opts admin-request tl "W" {:overlap-mode "non-overlapping"}))
        sl (id (create-span-layer admin-request wl "L"))
        rl (id (create-relation-layer admin-request sl "R"))
        txt (id (create-text admin-request tl doc (str/join " " (repeat n "a"))))
        toks (ids (call :post "/api/v1/tokens/bulk"
                        (vec (for [i (range n)] {:token-layer-id wl :text txt :begin (* 2 i) :end (inc (* 2 i))}))))]
    {:doc doc :wl wl :sl sl :rl rl :toks toks :vocab vocab}))

(defn- stale-statistics!
  "One relation and one vocabulary link in a tiny project, then ANALYZE."
  []
  (let [p (create-test-project admin-request "Tiny")
        v (id (create-vocab-layer admin-request "Tiny vocab"))
        _ (link-vocab-to-project admin-request p v)
        {:keys [sl rl toks]} (annotated-document p v "d" 2)
        sps (ids (call :post "/api/v1/spans/bulk" (mapv (fn [t] {:span-layer-id sl :tokens [t] :value "x"}) toks)))
        item (id (create-vocab-item admin-request v "x"))]
    (assert-status 201 (call :post "/api/v1/relations" {:layer-id rl :source-id (sps 0) :target-id (sps 1) :value "x"}))
    (assert-status 201 (call :post "/api/v1/vocab-links" {:vocab-item item :tokens [(first toks)]}))
    (psc/execute! db ["ANALYZE"])))

(defn- insert! [table rows]
  (doseq [chunk (partition-all 4000 rows)]
    (psc/execute! db {:insert-into table :values (vec chunk)})))

(defn- bystanders!
  "150,000 relations, vocabulary links and link tokens of another document,
  put in with plain inserts after the statistics were taken."
  [proj]
  (let [v (id (create-vocab-layer admin-request "Other vocab"))
        _ (link-vocab-to-project admin-request proj v)
        {:keys [doc sl rl toks]} (annotated-document proj v "Other" 2)
        [s1 s2] (ids (call :post "/api/v1/spans/bulk" (mapv (fn [t] {:span-layer-id sl :tokens [t] :value "x"}) toks)))
        item (id (create-vocab-item admin-request v "y"))
        link (id (call :post "/api/v1/vocab-links" {:vocab-item item :tokens [(first toks)]}))
        new-id #(str (psc/new-uuid))]
    (insert! :relations (for [_ (range bystanders)]
                          {:id (new-id) :relation_layer_id (str rl) :document_id (str doc)
                           :source_span_id (str s1) :target_span_id (str s2) :value (psc/write-json "x")}))
    (insert! :vocab_links (for [_ (range bystanders)]
                            {:id (new-id) :vocab_item_id (str item) :document_id (str doc)}))
    (insert! :vocab_link_tokens (for [i (range 1 (inc bystanders))]
                                  {:vocab_link_id (str link) :token_id (str (first toks)) :order_idx i}))))

(defn- run-route
  "Stale statistics, a project with `n-parents` of something to delete
  (`setup`), the bystanders, then the route (`route`), timed."
  [setup route]
  (stale-statistics!)
  (try
    (let [proj (create-test-project admin-request "P")
          vocab (id (create-vocab-layer admin-request "V"))
          _ (link-vocab-to-project admin-request proj vocab)
          fx (setup (annotated-document proj vocab "D" n-parents))
          _ (bystanders! proj)
          _ (evict-pool!)
          t (System/nanoTime)
          resp (route (assoc fx :proj proj))]
      [resp (/ (- (System/nanoTime) t) 1e6)])
    (finally
      (psc/execute! db ["ANALYZE"])
      (evict-pool!))))

(defn- spans-on [{:keys [sl toks] :as fx}]
  (assoc fx :spans (ids (call :post "/api/v1/spans/bulk"
                              (mapv (fn [t] {:span-layer-id sl :tokens [t] :value "x"}) toks)))))

(defn- links-on [{:keys [vocab toks] :as fx}]
  (let [item (id (create-vocab-item admin-request vocab "w"))]
    (assoc fx :item item
           :links (ids (call :post "/api/v1/vocab-links/bulk"
                             (mapv (fn [t] {:vocab-item item :tokens [t]}) toks))))))

(defn- items-in [{:keys [vocab] :as fx}]
  (assoc fx
         :survivor (id (create-vocab-item admin-request vocab "keep"))
         :items (ids (call :post "/api/v1/vocab-items/bulk"
                           (mapv (fn [i] {:vocab-layer-id vocab :form (str "f" i)}) (range n-parents))))))

(def ^:private routes
  "[name, setup, route]: each route deletes `n-parents` cascade parents."
  [["unlink a vocabulary from the project" links-on
    (fn [{:keys [proj vocab]}] (call :delete (str "/api/v1/projects/" proj "/vocabs/" vocab)))]
   ["merge entries" items-in
    (fn [{:keys [survivor items]}] (call :post (str "/api/v1/vocab-items/" survivor "/merge") {:losers items}))]
   ["repair a single-span layer" (comp (fn [fx] (spans-on (dissoc fx :spans))) spans-on)
    (fn [{:keys [sl doc]}] (call :post (str "/api/v1/span-layers/" sl "/constraints/repair")
                                 {:constraints [{:type "single-span"}] :document doc}))]
   ["restore the document to before its spans"
    (fn [fx] (let [ts (Instant/now)] (Thread/sleep 5) (assoc (spans-on fx) :ts ts)))
    (fn [{:keys [doc ts]}] (call :post (str "/api/v1/documents/" doc "/restore?as-of=" ts)))]
   ["bulk delete spans" spans-on
    (fn [{:keys [spans]}] (call :delete "/api/v1/spans/bulk" spans))]
   ["bulk delete tokens" spans-on
    (fn [{:keys [toks]}] (call :delete "/api/v1/tokens/bulk" toks))]
   ["delete the span layer" spans-on
    (fn [{:keys [sl]}] (call :delete (str "/api/v1/span-layers/" sl)))]
   ["bulk delete vocabulary links" links-on
    (fn [{:keys [links]}] (call :delete "/api/v1/vocab-links/bulk" links))]
   ["bulk delete vocabulary entries" items-in
    (fn [{:keys [items]}] (call :delete "/api/v1/vocab-items/bulk" items))]
   ["delete a vocabulary entry with its links" links-on
    (fn [{:keys [item]}] (call :delete (str "/api/v1/vocab-items/" item)))]
   ["delete the vocabulary" items-in
    (fn [{:keys [vocab]}] (call :delete (str "/api/v1/vocab-layers/" vocab)))]])

(defmacro ^:private route-test [sym n]
  `(deftest ~sym
     (let [[label# setup# route#] (nth routes ~n)
           [resp# ms#] (run-route setup# route#)]
       (testing label#
         (is (< (:status resp#) 300) (pr-str (:body resp#)))
         (is (< ms# limit-ms) (str label# " took " ms# " ms"))))))

(route-test unlinking-a-vocabulary 0)
(route-test merging-entries 1)
(route-test repairing-a-single-span-layer 2)
(route-test restoring-a-document 3)
(route-test bulk-deleting-spans 4)
(route-test bulk-deleting-tokens 5)
(route-test deleting-a-span-layer 6)
(route-test bulk-deleting-vocabulary-links 7)
(route-test bulk-deleting-vocabulary-entries 8)
(route-test deleting-a-vocabulary-entry 9)
(route-test deleting-a-vocabulary 10)
