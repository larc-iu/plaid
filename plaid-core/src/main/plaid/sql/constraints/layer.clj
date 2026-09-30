(ns plaid.sql.constraints.layer
  "Layer constraints: rules an app declares on the token, span and relation
  layers it owns, enforced by core inside every write transaction.

  A layer row's `constraints` column holds a JSON object from the declaring
  app's namespace to a list of constraint objects. Core enforces the union of
  every namespace's list. Seven types exist:

    max-in-degree  (relation layer)  a span is the target of at most `max`
                                     relations of the layer
    acyclic        (relation layer)  the layer's relations in a document form
                                     no cycle
    same-ancestor  (relation layer)  both ends of a relation lie in one token
                                     of `token-layer`
    single-span    (span layer)      a token is in at most one span of the
                                     layer
    value-set      (span or relation) a value is in a closed list
    coextensive    (token layer)     a token has the extent of a token of its
                                     parent layer
    single-link    (token layer)     a token is the only token of at most one
                                     vocabulary link

  The audit helpers note every row a transaction writes
  (`plaid.sql.audit-write/*pending*`). At the end of the transaction
  `finish!` checks the constraints those rows could break and classes each
  violation. A row written by an operation on its own kind (a `relation/*`
  op for a relation) is a direct violation, and the transaction is refused
  with 422. Any other violation was caused by a write elsewhere (a sentence
  split, a word merge, a text save, a restore), and core applies the type's
  remedy in the same transaction, as its own audited operation, or refuses
  when the type has none. The remedies only delete rows, except
  single-span's join of values.

  Core reads one metadata family here, provenance (`prov`, `provConfirmed`),
  which Plaid itself owns: an unverified machine value is exempt from
  value-set. So is a value written by an import (an operation group of kind
  `import`), since importers keep off-list values and warn, and a value a
  document copy or a restore from history writes, since those write back
  values already stored."
  (:require [clojure.string :as str]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.constraints.token :as tc]
            [plaid.sql.crud :as crud]
            [plaid.sql.operation :as op]
            [plaid.sql.token :as token]
            [plaid.server.locks :as locks]
            [taoensso.timbre :as log])
  (:import (clojure.lang ExceptionInfo)
           (java.util UUID)))

;; ============================================================
;; Types and their declarations
;; ============================================================

(def types-by-kind
  "The constraint types a layer of each kind may carry."
  {:token #{"coextensive" "single-link"}
   :span #{"single-span" "value-set"}
   :relation #{"max-in-degree" "acyclic" "same-ancestor" "value-set"}})

(def remediable
  "Types whose violations a structural write gets a remedy for. The others
  are refused wherever the violation comes from."
  #{"coextensive" "single-span" "single-link" "same-ancestor"})

(def ^:private remedy-order ["coextensive" "single-span" "single-link" "same-ancestor"])

(def max-listed
  "The most violations an answer lists. `violation-count` gives the total."
  100)

(def ^:private namespace-pattern #"^[a-z][a-zA-Z0-9]*$")

(def reserved-namespaces
  "Names the constraint routes use for themselves."
  #{"check" "repair"})

(def ^:private param-keys
  {"max-in-degree" #{"max"}
   "acyclic" #{"self-loops" "except-values"}
   "same-ancestor" #{"token-layer"}
   "single-span" #{"join-with"}
   "value-set" #{"values" "delimiters" "parts"}
   "coextensive" #{}
   "single-link" #{}})

(def ^:private max-values 10000)

(defn- u
  "An id as a UUID, whatever shape it came in."
  [x]
  (cond
    (uuid? x) x
    (string? x) (try (UUID/fromString x) (catch IllegalArgumentException _ x))
    :else x))

(defn- stringify-keys [m]
  (into {} (map (fn [[k v]] [(if (keyword? k) (name k) (str k)) v])) m))

(defn- bad [msg]
  (throw (ex-info msg {:code 400})))

(defn- string-list? [x]
  (and (sequential? x) (every? string? x)))

(defn- validate-one
  "The constraint `c` (string keys) checked against the layer it is declared
  on. Throws 400 naming the entry. Returns it with `values` deduplicated."
  [tx kind layer-row i c]
  (let [where (str "Constraint " (inc i))
        t (get c "type")]
    (when-not (string? t)
      (bad (str where " has no type.")))
    (when-not (contains? (types-by-kind kind) t)
      (bad (str where ": a " (name kind) " layer cannot carry a " t " constraint"
                (when-not (param-keys t) " (unknown type)") ".")))
    (when-let [unknown (seq (remove (conj (param-keys t) "type") (keys c)))]
      (bad (str where " (" t ") has unknown keys: " (str/join ", " (sort unknown)) ".")))
    (case t
      "max-in-degree"
      (let [m (get c "max")]
        (when-not (and (integer? m) (>= m 1))
          (bad (str where " (max-in-degree) needs max, an integer of at least 1.")))
        c)

      "acyclic"
      (do (when (and (contains? c "self-loops") (not (boolean? (get c "self-loops"))))
            (bad (str where " (acyclic): self-loops must be true or false.")))
          (when (and (contains? c "except-values") (not (string-list? (get c "except-values"))))
            (bad (str where " (acyclic): except-values must be a list of strings.")))
          c)

      "same-ancestor"
      (let [tl-id (u (get c "token-layer"))
            ancestor (when (uuid? tl-id) (psc/fetch-by-id tx :token_layers tl-id))
            own-tl (when-let [sl (psc/fetch-by-id tx :span_layers (:span_layer_id layer-row))]
                     (psc/fetch-by-id tx :token_layers (:token_layer_id sl)))]
        (when-not ancestor
          (bad (str where " (same-ancestor) needs token-layer, the id of a token layer.")))
        (when-not (= (str (:text_layer_id ancestor)) (str (:text_layer_id own-tl)))
          (bad (str where " (same-ancestor): token layer " tl-id
                    " is not on the text layer this relation layer's spans are on.")))
        (when-not (#{"partitioning" "non-overlapping"} (:overlap_mode ancestor))
          (bad (str where " (same-ancestor): token layer " tl-id
                    " must be partitioning or non-overlapping.")))
        (assoc c "token-layer" (str tl-id)))

      "single-span"
      (do (when (and (contains? c "join-with") (not (string? (get c "join-with"))))
            (bad (str where " (single-span): join-with must be a string.")))
          c)

      "value-set"
      (let [values (get c "values")
            delimiters (get c "delimiters" "")
            parts (get c "parts" "all")]
        (when-not (and (string-list? values) (every? #(not (str/blank? %)) values))
          (bad (str where " (value-set) needs values, a list of non-empty strings.")))
        (when (> (count values) max-values)
          (bad (str where " (value-set) lists more than " max-values " values.")))
        (when-not (and (string? delimiters) (not (re-find #"\s" delimiters)))
          (bad (str where " (value-set): delimiters must be a string with no whitespace.")))
        (when-not (#{"all" "first"} parts)
          (bad (str where " (value-set): parts must be \"all\" or \"first\".")))
        (assoc c "values" (vec (distinct values))))

      "coextensive"
      (do (when-not (:parent_token_layer_id layer-row)
            (bad (str where " (coextensive): the layer has no parent token layer.")))
          c)

      "single-link"
      c)))

(defn validate-list
  "Check a declared list for the layer `layer-row` of `kind` (:token, :span,
  :relation) and return it with string keys, as it is stored. Throws 400."
  [tx kind layer-row constraints]
  (when-not (sequential? constraints)
    (bad "constraints must be a list."))
  (let [cs (mapv (fn [c]
                   (when-not (map? c) (bad "Each constraint must be an object."))
                   (stringify-keys c))
                 constraints)]
    (when-let [dup (some (fn [[t n]] (when (> n 1) t)) (frequencies (map #(get % "type") cs)))]
      (bad (str "The list names " dup " twice.")))
    (vec (map-indexed (fn [i c] (validate-one tx kind layer-row i c)) cs))))

(defn validate-namespace!
  [ns]
  (when-not (and (string? ns) (re-matches namespace-pattern ns) (not (reserved-namespaces ns)))
    (bad (str "Namespace \"" ns "\" must start with a lowercase letter and hold only letters and digits"
              " (and may not be \"check\" or \"repair\")."))))

(defn normalize-list
  "A list as a client sent it (keyword or string keys), in the stored shape,
  for comparing with what is stored."
  [constraints]
  (when (some? constraints)
    (mapv (fn [c] (if (map? c) (stringify-keys c) c)) constraints)))

;; ============================================================
;; The constrained layers
;; ============================================================

(def ^:private table-of {:token :token_layers :span :span_layers :relation :relation_layers})

(defn parse-constraints
  "The `constraints` column read back, namespaces with no entries left out."
  [s]
  (into {} (filter (fn [[_ v]] (and (sequential? v) (seq v)))) (psc/parse-config s)))

(defn- layer-record [kind row]
  (-> row
      (assoc :kind kind
             :id (u (:id row))
             :constraints (parse-constraints (:constraints row)))
      (update :parent_token_layer_id u)
      (update :span_layer_id u)
      (update :token_layer_id u)
      (update :text_layer_id u)))

(defn- layer-queries
  "The three reads of the constrained layers, restricted by `where` (a clause
  on the layer's `project_id`)."
  [project-clause]
  {:token {:select [:id :name :constraints :parent_token_layer_id :text_layer_id :overlap_mode]
           :from :token_layers
           :where [:and [:<> :constraints "{}"] project-clause]}
   :span {:select [:id :name :constraints :token_layer_id]
          :from :span_layers
          :where [:and [:<> :constraints "{}"] project-clause]}
   :relation {:select [:rl.id :rl.name :rl.constraints :rl.span_layer_id [:sl.token_layer_id :token_layer_id]]
              :from [[:relation_layers :rl]]
              :join [[:span_layers :sl] [:= :sl.id :rl.span_layer_id]]
              :where [:and [:<> :rl.constraints "{}"]
                      (if (= :in (first project-clause))
                        [:in :rl.project_id (nth project-clause 2)]
                        project-clause)]}})

(defn- constrained-layers
  "Every layer carrying a declaration in the projects of `doc-ids`: three
  reads (one per layer table) for up to 4,000 documents."
  [tx doc-ids]
  (->> (partition-all 4000 (distinct doc-ids))
       (mapcat (fn [chunk]
                 (let [qs (layer-queries [:in :project_id {:select [:project_id]
                                                           :from :documents
                                                           :where [:in :id (vec chunk)]}])]
                   (for [kind [:token :span :relation]
                         row (psc/q tx (get qs kind))]
                     (layer-record kind row)))))
       (reduce (fn [m l] (assoc m (:id l) l)) {})
       vals
       (filter (comp seq :constraints))
       vec))

(defn layer-record-by-id
  "One layer of `kind` as the checks read it, or nil."
  [tx kind id]
  (when-let [row (case kind
                   :relation (psc/q1 tx {:select [:rl.id :rl.name :rl.constraints :rl.project_id :rl.span_layer_id
                                                  [:sl.token_layer_id :token_layer_id]]
                                         :from [[:relation_layers :rl]]
                                         :join [[:span_layers :sl] [:= :sl.id :rl.span_layer_id]]
                                         :where [:= :rl.id id]})
                   (psc/fetch-by-id tx (table-of kind) id))]
    (layer-record kind row)))

(defn- instances
  "Each (namespace, constraint) of `layers` as one map."
  [layers]
  (for [l layers
        [ns cs] (sort-by key (:constraints l))
        c cs
        :when (map? c)]
    {:ns ns :type (get c "type") :params c :layer l}))

;; ============================================================
;; Notes: what the transaction wrote
;; ============================================================

(defn- normalize-notes
  "The collector's map keyed by UUID ids, with layer and document ids as
  UUIDs. The audit helpers pass UUIDs nearly always, so a row is rebuilt
  only when one of its ids is a string."
  [notes]
  (persistent!
   (reduce-kv (fn [m [t id] info]
                (let [uid (u id)
                      k [t uid]
                      info (if (and (identical? uid id)
                                    (not (string? (:layer info)))
                                    (not (string? (:doc info))))
                             (assoc info :id uid)
                             (-> info (assoc :id uid) (update :layer u) (update :doc u)))]
                  (if-let [prev (get m k)]
                    (assoc! m k (merge-with (fn [a b]
                                              (cond (map? a) (merge-with into a b)
                                                    (set? a) (into a b)
                                                    :else b))
                                            prev info))
                    (assoc! m k info))))
              (transient {}) notes)))

(defn- notes-of
  "Noted rows of `table` on layer `layer-id`."
  [ctx table layer-id]
  (get-in ctx [:by-table-layer table layer-id]))

(defn- live-with
  "Noted rows of `table` on `layer-id` still present, changed in one of `cats`."
  [ctx table layer-id cats]
  (filter (fn [n] (and (not (:deleted? n)) (some #(seq (get (:kinds n) %)) cats)))
          (notes-of ctx table layer-id)))

(defn- index-notes [notes]
  (reduce (fn [m n] (update-in m [(:table n) (:layer n)] (fnil conj []) n)) {} (vals notes)))

(defn- make-ctx [tx notes & {:as opts}]
  (let [notes (normalize-notes notes)]
    (merge {:tx tx :mode :notes :notes notes :by-table-layer (index-notes notes)} opts)))

(defn- restrict-to-doc
  "The context with only the noted rows of document `doc`."
  [ctx doc]
  (if (= :all (:mode ctx))
    (assoc ctx :only-doc doc)
    (let [notes (into {} (filter (fn [[_ n]] (= doc (:doc n)))) (:notes ctx))]
      (assoc ctx :notes notes :by-table-layer (index-notes notes)))))

(defn- touched?
  "Whether the transaction changed `cat` of the row, by any operation."
  [ctx table id cat]
  (boolean (seq (get-in ctx [:notes [table (u id)] :kinds cat]))))

;; ============================================================
;; Helpers
;; ============================================================

(defn- q-chunks
  "Run `(query-fn chunk)` over `ids` in chunks of 4,000 and concatenate."
  [tx query-fn ids]
  (into [] (mapcat #(psc/q tx (query-fn (vec %)))) (partition-all 4000 (distinct ids))))

(defn- doc-clause
  "A `document_id` filter for `col` when the check is restricted to one document."
  [ctx col]
  (when-let [d (:only-doc ctx)] [:= col d]))

(defn- where-and [& clauses]
  (let [cs (remove nil? clauses)]
    (if (= 1 (count cs)) (first cs) (into [:and] cs))))

(defn- violation
  [{:keys [ns type layer params]} doc at ids & {:as extra}]
  (merge {:ns ns :type type :layer layer :params params :document (u doc) :at (some-> at u)
          :ids (vec (sort-by str (distinct (map u (seq ids)))))}
         extra))

(defn- read-value [s]
  (when (some? s)
    (try (psc/read-json s) (catch Exception _ s))))

;; ============================================================
;; max-in-degree
;; ============================================================

(defn- check-max-in-degree [{:keys [tx mode] :as ctx} {:keys [layer params] :as c}]
  (let [lid (:id layer)
        mx (get params "max")
        rows (if (= :all mode)
               (psc/q tx {:select [:id :target_span_id :document_id]
                          :from :relations
                          :where (where-and [:= :relation_layer_id lid]
                                            (doc-clause ctx :document_id)
                                            [:in :target_span_id {:select [:target_span_id]
                                                                  :from :relations
                                                                  :where (where-and [:= :relation_layer_id lid]
                                                                                    (doc-clause ctx :document_id))
                                                                  :group-by [:target_span_id]
                                                                  :having [:> [:count :*] mx]}])})
               (let [cands (map :id (live-with ctx "relations" lid [:edge]))]
                 (when (seq cands)
                   (let [targets (map :target_span_id
                                      (q-chunks tx (fn [ch] {:select [:target_span_id] :from :relations
                                                             :where [:in :id ch]})
                                                cands))]
                     (q-chunks tx (fn [ch] {:select [:id :target_span_id :document_id]
                                            :from :relations
                                            :where [:and [:= :relation_layer_id lid]
                                                    [:in :target_span_id ch]]})
                               targets)))))]
    (for [[t rs] (group-by (comp u :target_span_id) rows)
          :when (> (count rs) mx)]
      (violation c (:document_id (first rs)) t (map :id rs) :count (count rs)))))

;; ============================================================
;; acyclic
;; ============================================================

(defn- find-cycles
  "Cycles among `edges` ({:id :s :t}, no self-loops), found by an iterative
  depth-first search: one cycle, as its edge ids, per back edge met. Every
  node is visited once, so it is linear in the edges."
  [edges]
  (let [adj (group-by :s edges)
        color (java.util.HashMap.)
        found (volatile! [])]
    (doseq [start (distinct (map :s edges))
            :when (nil? (.get color start))]
      (.put color start :gray)
      (loop [stack (list [start (seq (get adj start))])
             path []]
        (when-let [[node remaining] (first stack)]
          (if-let [e (first remaining)]
            (let [stack (conj (rest stack) [node (next remaining)])
                  t (:t e)
                  c (.get color t)]
              (cond
                (nil? c)
                (do (.put color t :gray)
                    (recur (conj stack [t (seq (get adj t))]) (conj path e)))

                (= :gray c)
                (let [depth (if (= t start)
                              0
                              (inc (count (take-while #(not= t (:t %)) path))))]
                  (vswap! found conj (conj (mapv :id (subvec path depth)) (:id e)))
                  (recur stack path))

                :else (recur stack path)))
            (do (.put color node :black)
                (recur (rest stack) (if (seq path) (pop path) path)))))))
    @found))

(defn- path-ids
  "The edge ids of a path from `from` to `to` among `edges`, or nil."
  [edges from to]
  (let [adj (group-by :s edges)]
    (loop [queue (conj clojure.lang.PersistentQueue/EMPTY from)
           via {from nil}]
      (when-let [n (peek queue)]
        (if (= n to)
          (loop [n to acc ()]
            (if-let [e (get via n)]
              (recur (:s e) (conj acc (:id e)))
              (vec acc)))
          (let [next-edges (remove #(contains? via (:t %)) (get adj n))]
            (recur (into (pop queue) (map :t next-edges))
                   (reduce (fn [m e] (if (contains? m (:t e)) m (assoc m (:t e) e))) via next-edges))))))))

(defn- relation-edges
  "The edges of layer `lid` in document `doc` that count for acyclic."
  [tx lid doc excepted?]
  (->> (psc/q tx {:select [:id :source_span_id :target_span_id :value]
                  :from :relations
                  :where [:and [:= :relation_layer_id lid] [:= :document_id doc]]})
       (keep (fn [r]
               (let [s (u (:source_span_id r)) t (u (:target_span_id r))]
                 (when (and (not= s t) (not (excepted? (read-value (:value r)))))
                   {:id (u (:id r)) :s s :t t}))))
       vec))

(defn- reaches?
  "Whether span `from` reaches span `to` along the counted edges of layer `lid`."
  [tx lid excepted-json from to]
  (let [ex (vec excepted-json)
        sql (str "WITH RECURSIVE reach(span) AS (SELECT ?"
                 " UNION SELECT r.target_span_id FROM relations r JOIN reach ON r.source_span_id = reach.span"
                 " WHERE r.relation_layer_id = ? AND r.source_span_id <> r.target_span_id"
                 (when (seq ex)
                   (str " AND (r.value IS NULL OR r.value NOT IN (" (str/join "," (repeat (count ex) "?")) "))"))
                 ") SELECT 1 AS hit FROM reach WHERE span = ? LIMIT 1")]
    (some? (psc/q1 tx (-> [sql (str from) (str lid)] (into ex) (conj (str to)))))))

(defn- check-acyclic [{:keys [tx mode] :as ctx} {:keys [layer params] :as c}]
  (let [lid (:id layer)
        self-ok? (true? (get params "self-loops"))
        except (set (get params "except-values"))
        excepted? (fn [v] (and (string? v) (contains? except v)))
        excepted-json (map psc/write-json except)
        cycle-violations (fn [doc cycles]
                           (->> cycles
                                (map set)
                                distinct
                                (map #(violation c doc nil %))))]
    (if (= :all mode)
      (let [rows (psc/q tx {:select [:id :source_span_id :target_span_id :value :document_id]
                            :from :relations
                            :where (where-and [:= :relation_layer_id lid] (doc-clause ctx :document_id))})]
        (concat
         (for [r rows
               :when (and (= (str (:source_span_id r)) (str (:target_span_id r)))
                          (not self-ok?)
                          (not (excepted? (read-value (:value r)))))]
           (violation c (:document_id r) (:source_span_id r) [(:id r)]))
         (mapcat (fn [[doc rs]]
                   (cycle-violations doc (find-cycles
                                          (keep (fn [r]
                                                  (let [s (u (:source_span_id r)) t (u (:target_span_id r))]
                                                    (when (and (not= s t) (not (excepted? (read-value (:value r)))))
                                                      {:id (u (:id r)) :s s :t t})))
                                                rs))))
                 (group-by (comp u :document_id) rows))))
      (let [cands (live-with ctx "relations" lid [:edge :value])]
        (when (seq cands)
          (let [rows (q-chunks tx (fn [ch] {:select [:id :source_span_id :target_span_id :value :document_id]
                                            :from :relations :where [:in :id ch]})
                               (map :id cands))]
            (mapcat
             (fn [[doc rs]]
               (let [self (for [r rs
                                :when (and (= (str (:source_span_id r)) (str (:target_span_id r)))
                                           (not self-ok?)
                                           (not (excepted? (read-value (:value r)))))]
                            (violation c doc (:source_span_id r) [(:id r)]))
                     counted (filter (fn [r] (and (not= (str (:source_span_id r)) (str (:target_span_id r)))
                                                  (not (excepted? (read-value (:value r))))))
                                     rs)]
                 (concat
                  self
                  (if (> (count counted) 50)
                    (cycle-violations doc (find-cycles (relation-edges tx lid doc excepted?)))
                    (let [edges (delay (relation-edges tx lid doc excepted?))]
                      (cycle-violations
                       doc
                       (for [r counted
                             :let [s (u (:source_span_id r)) t (u (:target_span_id r))]
                             :when (reaches? tx lid excepted-json t s)]
                         (conj (or (path-ids @edges t s) []) (u (:id r))))))))))
             (group-by (comp u :document_id) rows))))))))

;; ============================================================
;; same-ancestor
;; ============================================================

(defn- places
  "Span id -> place (the smallest begin of its tokens) for `span-ids`."
  [tx span-ids]
  (into {}
        (map (fn [r] [(u (:span_id r)) (:place r)]))
        (q-chunks tx (fn [ch] {:select [:st.span_id [[:min :t.begin] :place]]
                               :from [[:span_tokens :st]]
                               :join [[:tokens :t] [:= :t.id :st.token_id]]
                               :where [:in :st.span_id ch]
                               :group-by [:st.span_id]})
                  span-ids)))

(defn- crossing
  "The relations among `rels` whose two places are not in one token."
  [anc place-of rels]
  (filter (fn [r]
            (let [a (anc (place-of (u (:source_span_id r))))
                  b (anc (place-of (u (:target_span_id r))))]
              (or (nil? a) (nil? b) (not= a b))))
          rels))

(def ^:private crossing-sql
  "The relations of a layer in one document whose two places are not in one
  token of the ancestor layer, worked out in SQLite: a relation layer's
  spans with their place (the smallest begin of their tokens), the nearest
  ancestor token starting at or before it by an index seek, whether it
  reaches past the place, and the relations whose two ends differ. Tens of
  thousands of index seeks, and only the violations leave the database."
  (str "WITH place AS ("
       " SELECT st.span_id AS span_id, min(t.begin) AS p"
       " FROM spans s JOIN span_tokens st ON st.span_id = s.id JOIN tokens t ON t.id = st.token_id"
       " WHERE s.span_layer_id = ? AND s.document_id = ? GROUP BY st.span_id),"
       " cand AS ("
       " SELECT place.span_id AS span_id, place.p AS p,"
       " (SELECT a.id FROM tokens a WHERE a.token_layer_id = ? AND a.document_id = ? AND a.begin <= place.p"
       " ORDER BY a.begin DESC LIMIT 1) AS a"
       " FROM place),"
       " anc AS ("
       " SELECT cand.span_id AS span_id, CASE WHEN tok.end_ > cand.p THEN cand.a END AS a"
       " FROM cand LEFT JOIN tokens tok ON tok.id = cand.a)"
       " SELECT r.id AS id FROM relations r"
       " LEFT JOIN anc s ON s.span_id = r.source_span_id"
       " LEFT JOIN anc t ON t.span_id = r.target_span_id"
       " WHERE r.relation_layer_id = ? AND r.document_id = ?"
       " AND (s.a IS NULL OR t.a IS NULL OR s.a <> t.a)"))

(defn- crossing-in-sql [tx lid sl al doc]
  (psc/q tx [crossing-sql (str sl) (str doc) (str al) (str doc) (str lid) (str doc)]))

(defn- check-same-ancestor [{:keys [tx mode] :as ctx} {:keys [layer params] :as c}]
  (let [lid (:id layer)
        sl (:span_layer_id layer)
        tl (:token_layer_id layer)
        al (u (get params "token-layer"))
        whole (fn [doc]
                (map #(violation c doc nil [(:id %)]) (crossing-in-sql tx lid sl al doc)))]
    (if (= :all mode)
      (mapcat whole (if-let [d (:only-doc ctx)]
                      [d]
                      (map (comp u :document_id)
                           (psc/q tx {:select-distinct [:document_id] :from :relations
                                      :where [:= :relation_layer_id lid]}))))
      (let [token-docs (set (concat
                             (keep (fn [n] (when (or (:deleted? n) (seq (get-in n [:kinds :extent]))) (:doc n)))
                                   (notes-of ctx "tokens" al))
                             (when (not= al tl)
                               (keep (fn [n] (when (or (:deleted? n) (seq (get-in n [:kinds :extent]))) (:doc n)))
                                     (notes-of ctx "tokens" tl)))))
            ;; A span that was there before and moved to other tokens: its
            ;; relations are checked one by one. A new span has none yet (one
            ;; made for it is noted as a relation write), and a deleted one
            ;; took its relations with it.
            moved (keep (fn [n] (when (and (not (:deleted? n)) (some? (:pre n))
                                           (seq (get-in n [:kinds :tokens])))
                                  (:id n)))
                        (notes-of ctx "spans" sl))
            moved-rels (when (seq moved)
                         (q-chunks tx (fn [ch] {:select [:id :document_id] :from :relations
                                                :where [:and [:= :relation_layer_id lid]
                                                        [:or [:in :source_span_id ch] [:in :target_span_id ch]]]})
                                   moved))
            rel-cands (->> (concat (live-with ctx "relations" lid [:edge])
                                   (map (fn [r] {:id (u (:id r)) :doc (u (:document_id r))}) moved-rels))
                           (remove #(token-docs (:doc %)))
                           (group-by :doc))]
        (concat
         (mapcat whole token-docs)
         (mapcat (fn [[doc ns]]
                   (let [rels (q-chunks tx (fn [ch] {:select [:id :source_span_id :target_span_id]
                                                     :from :relations :where [:in :id ch]})
                                        (distinct (map :id ns)))
                         place-of (places tx (mapcat (juxt :source_span_id :target_span_id) rels))
                         anc-rows (fn [place]
                                    (when (some? place)
                                      (psc/q1 tx {:select [:begin :end_] :from :tokens
                                                  :where [:and [:= :token_layer_id al] [:= :document_id doc]
                                                          [:<= :begin place]]
                                                  :order-by [[:begin :desc]]
                                                  :limit 1})))
                         anc (fn [place]
                               (when-let [r (anc-rows place)]
                                 (when (< place (:end_ r)) (:begin r))))]
                     (map #(violation c doc nil [(:id %)]) (crossing anc place-of rels))))
                 rel-cands))))))

;; ============================================================
;; single-span
;; ============================================================

(defn- check-single-span [{:keys [tx mode] :as ctx} {:keys [layer] :as c}]
  (let [lid (:id layer)
        rows (if (= :all mode)
               (psc/q tx {:select [:st.token_id :st.span_id :s.document_id]
                          :from [[:span_tokens :st]]
                          :join [[:spans :s] [:= :s.id :st.span_id]]
                          :where (where-and [:= :s.span_layer_id lid]
                                            (doc-clause ctx :s.document_id)
                                            [:in :st.token_id {:select [:st2.token_id]
                                                               :from [[:span_tokens :st2]]
                                                               :join [[:spans :s2] [:= :s2.id :st2.span_id]]
                                                               :where (where-and [:= :s2.span_layer_id lid]
                                                                                 (doc-clause ctx :s2.document_id))
                                                               :group-by [:st2.token_id]
                                                               :having [:> [:count :*] 1]}])})
               (let [cands (map :id (live-with ctx "spans" lid [:tokens]))]
                 (when (seq cands)
                   (let [tokens (map :token_id (q-chunks tx (fn [ch] {:select [:token_id] :from :span_tokens
                                                                      :where [:in :span_id ch]})
                                                         cands))]
                     (q-chunks tx (fn [ch] {:select [:st.token_id :st.span_id :s.document_id]
                                            :from [[:span_tokens :st]]
                                            :join [[:spans :s] [:= :s.id :st.span_id]]
                                            :where [:and [:= :s.span_layer_id lid] [:in :st.token_id ch]]})
                               tokens)))))]
    (for [[t rs] (group-by (comp u :token_id) rows)
          :when (> (count (distinct (map :span_id rs))) 1)]
      (violation c (:document_id (first rs)) t (map :span_id rs)))))

;; ============================================================
;; value-set
;; ============================================================

(def ^:private js-space
  "What JavaScript's String.prototype.trim trims: Unicode White_Space (the
  space separators, tab, line tabulation, form feed and the line
  terminators) and the byte order mark. Not U+0085 or U+180E, and not
  U+001C to U+001F, which Java's isWhitespace counts. The apps trim with
  JavaScript, so a value they read as listed is read so here too."
  "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]")

(def ^:private js-trim-re (re-pattern (str "^" js-space "+|" js-space "+$")))

(defn- js-trim [^String s] (str/replace s js-trim-re ""))

(defn- js-blank? [^String s] (= "" (js-trim s)))

(defn- split-parts
  "`v` split on every code point of `delimiters`, empty parts kept."
  [^String v ^String delimiters]
  (if (empty? delimiters)
    [v]
    (let [ds (set (iterator-seq (.iterator (.boxed (.codePoints delimiters)))))
          sb (StringBuilder.)
          out (java.util.ArrayList.)]
      (doseq [cp (iterator-seq (.iterator (.boxed (.codePoints v))))]
        (if (contains? ds cp)
          (do (.add out (str sb)) (.setLength sb 0))
          (.appendCodePoint sb (int cp))))
      (.add out (str sb))
      (vec out))))

(defn- value-checker
  "A function from a stored value to nil (allowed) or the parts not in the set."
  [params]
  (let [delimiters (get params "delimiters" "")
        first? (= "first" (get params "parts" "all"))
        allowed (if first?
                  (set (map #(js-trim (first (split-parts % delimiters))) (get params "values")))
                  (set (get params "values")))]
    (fn [v]
      (cond
        (nil? v) nil
        (not (string? v)) {:parts []}
        (js-blank? v) nil
        first? (let [p (js-trim (first (split-parts v delimiters)))]
                 (when-not (contains? allowed p) {:parts [p]}))
        :else (let [bad (vec (keep (fn [p] (let [p (js-trim p)]
                                             (when-not (and (seq p) (contains? allowed p)) p)))
                                   (split-parts v delimiters)))]
                (when (seq bad) {:parts bad}))))))

(defn value-allowed?
  "Whether the value-set constraint `params` (string keys) allows `v`."
  [params v]
  (nil? ((value-checker params) v)))

(defn- machine-unverified-ids
  "The ids among `ids` whose metadata marks an unverified machine value:
  `prov` present and not \"contributed\", and no `provConfirmed: true`."
  [tx entity-type ids]
  (let [rows (q-chunks tx (fn [ch] {:select [:entity_id :key :value]
                                    :from :entity_metadata
                                    :where [:and [:= :entity_type entity-type]
                                            [:in :entity_id ch]
                                            [:in :key ["prov" "provConfirmed"]]]})
                       ids)]
    (->> (group-by (comp u :entity_id) rows)
         (keep (fn [[id rs]]
                 (let [m (into {} (map (fn [r] [(:key r) (read-value (:value r))])) rs)
                       prov (get m "prov")]
                   (when (and (some? prov) (not= "contributed" prov) (not (true? (get m "provConfirmed"))))
                     id))))
         set)))

(defn- import-groups
  "The ids among `group-ids` of operation groups of kind import."
  [tx group-ids]
  (let [ids (remove #(or (nil? %) (keyword? %)) group-ids)]
    (if (empty? ids)
      #{}
      (set (map (comp u :id)
                (q-chunks tx (fn [ch] {:select [:id] :from :operation_groups
                                       :where [:and [:in :id ch] [:= :kind "import"]]})
                          ids))))))

(def ^:private reproducing-op-types
  "Operations that write back values already stored, whose values keep an
  import's exemption: a document copy and a restore from history."
  #{"document/copy" "document/restore"})

(defn- import-set-ids
  "The ids among `rows` (id, value as stored) whose current value was set
  by a write in an operation group of kind import, or by a copy or a
  restore, read from the audit log: the oldest write of the newest run of
  writes that left the value as it is."
  [tx table rows]
  (let [current (into {} (map (fn [r] [(u (:id r)) (:value r)])) rows)
        audit (q-chunks tx (fn [ch] {:select [:aw.target_id :aw.post_image :og.kind :o.op_type]
                                     :from [[:audit_writes :aw]]
                                     :join [[:operations :o] [:= :o.id :aw.op_id]]
                                     :left-join [[:operation_groups :og] [:= :og.id :o.group_id]]
                                     :where [:and [:= :aw.target_table (name table)]
                                             [:in :aw.target_id (mapv str ch)]]
                                     :order-by [[:aw.ts :desc] [:aw.seq :desc]]})
                        (keys current))]
    (->> (group-by (comp u :target_id) audit)
         (keep (fn [[id rs]]
                 (let [cur (get current id)
                       run (take-while (fn [r] (when-let [img (some-> (:post_image r) psc/read-json)]
                                                 (= cur (:value img))))
                                       rs)
                       setter (last run)]
                   (when (or (= "import" (:kind setter))
                             (reproducing-op-types (:op_type setter)))
                     id))))
         set)))

(defn- check-value-set [{:keys [tx mode] :as ctx} {:keys [layer params] :as c}]
  (let [lid (:id layer)
        [table layer-col entity-type] (if (= :span (:kind layer))
                                        [:spans :span_layer_id "span"]
                                        [:relations :relation_layer_id "relation"])
        problem (value-checker params)
        cands (when-not (= :all mode) (live-with ctx (name table) lid [:value]))
        rows (if (= :all mode)
               (psc/q tx {:select [:id :value :document_id] :from table
                          :where (where-and [:= layer-col lid] (doc-clause ctx :document_id))})
               (when (seq cands)
                 (q-chunks tx (fn [ch] {:select [:id :value :document_id] :from table :where [:in :id ch]})
                           (map :id cands))))
        failing (keep (fn [r] (when-let [p (problem (read-value (:value r)))] (assoc r :problem p))) rows)]
    (when (seq failing)
      (let [machine (machine-unverified-ids tx entity-type (map :id failing))
            imported (if (= :all mode)
                       (import-set-ids tx table failing)
                       (let [groups-of (into {} (map (fn [n] [(:id n) (:value-groups n)])) cands)
                             imports (import-groups tx (mapcat :value-groups cands))]
                         (set (keep (fn [[id gs]]
                                      (when (and (seq gs)
                                                 (every? #(or (= :reproduced %)
                                                              (and % (contains? imports (u %))))
                                                         gs))
                                        id))
                                    groups-of))))]
        (for [r failing
              :let [id (u (:id r))]
              :when (not (or (machine id) (imported id)))]
          (violation c (:document_id r) id [id]
                     :value (read-value (:value r))
                     :parts (get-in r [:problem :parts])))))))

;; ============================================================
;; coextensive
;; ============================================================

(defn- orphans-whole
  "Tokens of layer `child` with no token of `parent` of the same extent, in
  every document or in `doc`."
  [tx child parent doc]
  (psc/q tx {:select [:c.id :c.document_id :c.begin :c.end_]
             :from [[:tokens :c]]
             :where (where-and [:= :c.token_layer_id child]
                               (when doc [:= :c.document_id doc])
                               [:not [:exists {:select [1] :from [[:tokens :p]]
                                               :where [:and [:= :p.token_layer_id parent]
                                                       [:= :p.document_id :c.document_id]
                                                       [:= :p.begin :c.begin]
                                                       [:= :p.end_ :c.end_]]}]])}))

(defn- check-coextensive [{:keys [tx mode] :as ctx} {:keys [layer] :as c}]
  (let [child (:id layer)
        parent (:parent_token_layer_id layer)
        ->v (fn [r] (violation c (:document_id r) (:id r) [(:id r)]))]
    (if (= :all mode)
      (map ->v (orphans-whole tx child parent (:only-doc ctx)))
      (let [children (group-by :doc (live-with ctx "tokens" child [:extent]))
            parents (group-by :doc (filter (fn [n] (or (:deleted? n) (seq (get-in n [:kinds :extent]))))
                                           (notes-of ctx "tokens" parent)))]
        (mapcat
         (fn [doc]
           (let [ps (get parents doc)]
             (map ->v
                  (if (> (count ps) 1000)
                    (orphans-whole tx child parent doc)
                    (let [pre-begins (keep (comp :begin :pre) ps)
                          cands (concat
                                 (q-chunks tx (fn [ch] {:select [:id :document_id :begin :end_] :from :tokens
                                                        :where [:in :id ch]})
                                           (map :id (get children doc)))
                                 (q-chunks tx (fn [ch] {:select [:id :document_id :begin :end_] :from :tokens
                                                        :where [:and [:= :token_layer_id child]
                                                                [:= :document_id doc] [:in :begin ch]]})
                                           pre-begins))
                          extents (set (map (juxt :begin :end_)
                                            (q-chunks tx (fn [ch] {:select [:begin :end_] :from :tokens
                                                                   :where [:and [:= :token_layer_id parent]
                                                                           [:= :document_id doc] [:in :begin ch]]})
                                                      (map :begin cands))))]
                      (->> cands
                           (remove #(contains? extents [(:begin %) (:end_ %)]))
                           (reduce (fn [m r] (assoc m (u (:id r)) r)) {})
                           vals))))))
         (distinct (concat (keys children) (keys parents))))))))

;; ============================================================
;; single-link
;; ============================================================

(defn- check-single-link [{:keys [tx mode] :as ctx} {:keys [layer] :as c}]
  (let [lid (:id layer)
        single-only [:not [:exists {:select [1] :from [[:vocab_link_tokens :o]]
                                    :where [:and [:= :o.vocab_link_id :vlt.vocab_link_id]
                                            [:<> :o.token_id :vlt.token_id]]}]]
        rows (if (= :all mode)
               (psc/q tx {:select [:vlt.token_id :vlt.vocab_link_id :t.document_id]
                          :from [[:vocab_link_tokens :vlt]]
                          :join [[:tokens :t] [:= :t.id :vlt.token_id]]
                          :where (where-and [:= :t.token_layer_id lid]
                                            (doc-clause ctx :t.document_id)
                                            single-only)})
               (let [links (->> (get-in ctx [:by-table-layer "vocab_links"])
                                vals
                                (apply concat)
                                (filter (fn [n] (and (not (:deleted? n)) (seq (get-in n [:kinds :tokens])))))
                                (map :id))]
                 (when (seq links)
                   (let [tokens (map :token_id (q-chunks tx (fn [ch] {:select [:token_id] :from :vocab_link_tokens
                                                                      :where [:in :vocab_link_id ch]})
                                                         links))]
                     (q-chunks tx (fn [ch] {:select [:vlt.token_id :vlt.vocab_link_id :t.document_id]
                                            :from [[:vocab_link_tokens :vlt]]
                                            :join [[:tokens :t] [:= :t.id :vlt.token_id]]
                                            :where [:and [:in :vlt.token_id ch] [:= :t.token_layer_id lid]
                                                    single-only]})
                               tokens)))))]
    (for [[t rs] (group-by (comp u :token_id) rows)
          :when (> (count (distinct (map :vocab_link_id rs))) 1)]
      (violation c (:document_id (first rs)) t (map :vocab_link_id rs)))))

;; ============================================================
;; Checking
;; ============================================================

(defn- check-one [ctx c]
  (case (:type c)
    "max-in-degree" (check-max-in-degree ctx c)
    "acyclic" (check-acyclic ctx c)
    "same-ancestor" (check-same-ancestor ctx c)
    "single-span" (check-single-span ctx c)
    "value-set" (check-value-set ctx c)
    "coextensive" (check-coextensive ctx c)
    "single-link" (check-single-link ctx c)
    []))

(defn- check-all [ctx cs]
  (vec (mapcat #(check-one ctx %) cs)))

(def ^:private direct-spec
  {"max-in-degree" ["relations" [:edge]]
   "acyclic" ["relations" [:edge :value]]
   "same-ancestor" ["relations" [:edge]]
   "single-span" ["spans" [:tokens]]
   "coextensive" ["tokens" [:extent]]
   "single-link" ["vocab_links" [:tokens]]})

(def ^:private own-kind
  {"relations" "relation" "spans" "span" "tokens" "token" "vocab_links" "vocab-link"})

(defn- direct?
  "Whether a row of the violation was changed, in what the constraint reads,
  by an operation on the row's own kind."
  [ctx v]
  (let [[table cats] (if (= "value-set" (:type v))
                       [(if (= :span (:kind (:layer v))) "spans" "relations") [:value]]
                       (direct-spec (:type v)))
        own (own-kind table)]
    (boolean (some (fn [id]
                     (let [kinds (get-in ctx [:notes [table id] :kinds])]
                       (some #(contains? (get kinds %) own) cats)))
                   (:ids v)))))

;; ============================================================
;; Violations on the wire
;; ============================================================

(defn- layer-name [tx kind id]
  (:name (psc/q1 tx {:select [:name] :from (table-of kind) :where [:= :id id]})))

(defn- phrase
  "The first violation in words that name layers by their names, never apps,
  and read on screen as they are."
  [tx {:keys [type layer params] :as v}]
  (let [ln (str "\"" (:name layer) "\"")
        q (fn [x] (str "\"" x "\""))]
    (case type
      "max-in-degree" (str "A span is the target of " (:count v) " relations in " ln
                           " (at most " (get params "max") " " (if (= 1 (get params "max")) "is" "are") " allowed).")
      "acyclic" (str "Relations in " ln " form a cycle.")
      "same-ancestor" (str "A relation in " ln " connects spans that are not in one "
                           (q (layer-name tx :token (u (get params "token-layer")))) ".")
      "single-span" (str "A token has " (count (:ids v)) " values in " ln " (at most 1 is allowed).")
      "value-set" (let [value (:value v)
                        parts (:parts v)]
                    (cond
                      (not (string? value)) (str "A value in " ln " is not text, and only listed values are allowed.")
                      (or (empty? parts) (= [value] parts)) (str (q value) " is not in the list of values for " ln ".")
                      :else (str (q value) " is not allowed in " ln ": "
                                 (str/join ", " (map q parts))
                                 (if (= 1 (count parts)) " is" " are") " not in its list of values.")))
      "coextensive" (str "A token of " ln " does not have the extent of any token of "
                         (q (layer-name tx :token (:parent_token_layer_id layer))) ".")
      "single-link" (str "A token of " ln " has " (count (:ids v))
                         " vocabulary links (at most 1 is allowed).")
      (str "A rule of " ln " is broken."))))

(defn wire
  "A violation as an answer lists it."
  [v]
  (cond-> {:constraint (:type v)
           :namespace (:ns v)
           :layer (str (:id (:layer v)))
           :layer-name (:name (:layer v))
           :document (some-> (:document v) str)
           :at (some-> (:at v) str)
           :ids (mapv str (:ids v))}
    (= "value-set" (:type v)) (assoc :value (:value v) :parts (:parts v))))

(defn- dedupe-violations [vs]
  (vals (reduce (fn [m v] (let [k [(:type v) (:ns v) (:id (:layer v)) (:ids v)]]
                            (if (contains? m k) m (assoc m k v))))
                (array-map) vs)))

(defn violation-body
  "`{:error :violations :violation-count}` for the violations `vs`."
  [tx vs]
  (let [vs (vec (dedupe-violations vs))]
    {:error (phrase tx (first vs))
     :violations (mapv wire (take max-listed vs))
     :violation-count (count vs)}))

(defn refusal
  "The ex-info a refused write throws: 422, with the violations in its data
  and noted for the request's answer (`psaw/*refusal*`)."
  [tx vs]
  (let [{:keys [error violations violation-count] :as body} (violation-body tx vs)]
    (when psaw/*refusal*
      (reset! psaw/*refusal* {:violations violations :violation-count violation-count}))
    (ex-info error {:code 422
                    :violations violations
                    :violation-count violation-count
                    :plaid/body (dissoc body :error)})))

;; ============================================================
;; Remedies
;; ============================================================

(defn- sweep-metadata! [tx entity-type ids]
  (when (seq ids)
    (doseq [ch (partition-all 4000 ids)]
      (psc/execute! tx {:delete-from :entity_metadata
                        :where [:and [:= :entity_type entity-type] [:in :entity_id (vec ch)]]}))))

(defn- delete-relations! [tx ids]
  (when (seq ids)
    (let [gone (mapcat (fn [ch] (crud/delete-where! tx :relations [:in :id (vec ch)]))
                       (partition-all 4000 (distinct ids)))]
      (sweep-metadata! tx "relation" (map :id gone))
      (count gone))))

(defn- delete-spans!
  "Delete spans with the relations on them first, as a span delete does."
  [tx ids]
  (when (seq ids)
    (let [ids (vec (distinct ids))
          rels (map :id (q-chunks tx (fn [ch] {:select-distinct [:id] :from :relations
                                               :where [:or [:in :source_span_id ch] [:in :target_span_id ch]]})
                                  ids))]
      (delete-relations! tx rels)
      (let [gone (mapcat (fn [ch] (crud/delete-where! tx :spans [:in :id (vec ch)])) (partition-all 4000 ids))]
        (sweep-metadata! tx "span" (map :id gone))
        (count gone)))))

(defn- remedy-coextensive! [tx _ctx _c vs counts]
  (let [by-id (into {} (map (fn [v] [(first (:ids v)) v])) vs)]
    (when (seq by-id)
      (let [rows (q-chunks tx (fn [ch] {:select [:id :token_layer_id :document_id :begin :end_]
                                        :from :tokens :where [:in :id ch]})
                           (keys by-id))
            dlids (memoize (fn [layer] (tc/descendant-layer-ids tx layer)))
            all-ids (distinct (concat (map (comp u :id) rows)
                                      (mapcat (fn [r]
                                                (map (comp u :token/id)
                                                     (tc/descendant-tokens-in-extent
                                                      tx (dlids (:token_layer_id r)) (:document_id r)
                                                      (:begin r) (:end_ r))))
                                              rows)))]
        (token/multi-delete! tx (vec all-ids))
        (swap! counts update ["coextensive" :tokens "deleted" (:name (:layer (first vs)))] (fnil + 0) (count rows))))))

(defn- pre-begin
  "Where a span sat before the transaction: the smallest begin, before it, of
  the tokens it had then."
  [tx ctx span-id]
  (let [note (get-in ctx [:notes ["spans" (u span-id)]])
        tokens (or (:pre-tokens note)
                   (map :token_id (psc/q tx {:select [:token_id] :from :span_tokens
                                             :where [:= :span_id span-id]})))
        begins (keep (fn [tid]
                       (or (get-in ctx [:notes ["tokens" (u tid)] :pre :begin])
                           (:begin (psc/fetch-by-id tx :tokens (u tid)))))
                     tokens)]
    (if (seq begins) (apply min begins) Long/MAX_VALUE)))

(defn- joined-value
  "The value a single-span remedy leaves on `keep`: the distinct non-empty
  string values, keep's first, joined with `join-with`. A non-string value
  on keep stays."
  [keep-value others join-with]
  (cond
    (and (some? keep-value) (not (string? keep-value))) keep-value
    :else (let [strings (distinct (filter #(and (string? %) (not (js-blank? %)))
                                          (cons keep-value others)))]
            (if (seq strings) (str/join join-with strings) keep-value))))

(defn- remedy-single-span! [tx ctx {:keys [params layer] :as _c} vs counts]
  (let [join-with (get params "join-with" " | ")
        ;; The value-sets stored on the layer. A repair checks no list it is
        ;; about to declare: it joins, as the heals before it did, and the
        ;; joined value is left for that list's value-set to report.
        value-checks (for [[_ cs] (:constraints layer) c cs
                           :when (= "value-set" (get c "type"))]
                       (value-checker c))
        deleted (volatile! #{})
        repair? (:repair? ctx)]
    (doseq [v vs]
      (let [ids (remove @deleted (:ids v))]
        (when (> (count ids) 1)
          (let [rows (q-chunks tx (fn [ch] {:select [:id :value] :from :spans :where [:in :id ch]}) ids)
                rows (map #(update % :id u) rows)
                untouched (remove #(touched? ctx "spans" (:id %) :tokens) rows)
                keep (if repair?
                       (first (sort-by (comp str :id) rows))
                       (or (first (sort-by (comp str :id) untouched)) (first (sort-by (comp str :id) rows))))
                others (->> rows
                            (remove #(= (:id %) (:id keep)))
                            (sort-by (if repair?
                                       (comp str :id)
                                       (juxt #(pre-begin tx ctx (:id %)) (comp str :id)))))
                keep-value (read-value (:value keep))
                joined (joined-value keep-value (map (comp read-value :value) others) join-with)
                refused? (some #(% joined) value-checks)]
            ;; A repair deletes no value: a join a stored value-set refuses
            ;; leaves the token as it is, and its single-span violation stays.
            (when-not (and repair? refused?)
              (let [new-value (if refused? keep-value joined)]
                (when (not= new-value keep-value)
                  (crud/update-by-id! tx :spans (:id keep) {:value (psc/write-json new-value)})
                  (swap! counts update ["single-span" :spans "joined" (:name layer)] (fnil + 0) 1))
                (let [n (delete-spans! tx (map :id others))]
                  (vswap! deleted into (map :id others))
                  (swap! counts update ["single-span" :spans "deleted" (:name layer)] (fnil + 0) (or n 0)))))))))))

(defn- remedy-single-link! [tx ctx {:keys [layer]} vs counts]
  (let [deleted (volatile! #{})
        repair? (:repair? ctx)]
    (doseq [v vs]
      (let [ids (remove @deleted (:ids v))]
        (when (> (count ids) 1)
          (let [untouched (remove #(touched? ctx "vocab_links" % :tokens) ids)
                keep (if repair?
                       (first (sort-by str ids))
                       (or (first (sort-by str untouched)) (first (sort-by str ids))))
                others (remove #(= % keep) ids)
                gone (mapcat (fn [ch] (crud/delete-where! tx :vocab_links [:in :id (vec ch)]))
                             (partition-all 4000 others))]
            (sweep-metadata! tx "vocab-link" (map :id gone))
            (vswap! deleted into others)
            (swap! counts update ["single-link" :vocabulary-links "deleted" (:name layer)] (fnil + 0) (count gone))))))))

(defn- remedy-same-ancestor! [tx _ctx {:keys [layer]} vs counts]
  (let [n (delete-relations! tx (mapcat :ids vs))]
    (swap! counts update ["same-ancestor" :relations "deleted" (:name layer)] (fnil + 0) (or n 0))))

(defn- remedy! [tx ctx c vs counts]
  (case (:type c)
    "coextensive" (remedy-coextensive! tx ctx c vs counts)
    "single-span" (remedy-single-span! tx ctx c vs counts)
    "single-link" (remedy-single-link! tx ctx c vs counts)
    "same-ancestor" (remedy-same-ancestor! tx ctx c vs counts)
    nil))

(defn- describe-counts
  [counts]
  (str/join ", "
            (for [[[_ noun verb layer] n] (sort-by (comp str key) counts)
                  :when (pos? n)]
              (str n " " (if (= 1 n)
                           (case noun :tokens "token" :spans "span" :relations "relation"
                                 :vocabulary-links "vocabulary link")
                           (str/replace (name noun) "-" " "))
                   " of \"" layer "\" " verb))))

(defn- remedy-document!
  "Apply the remedies of the constraints `cs` to document `doc`, as one
  audited operation of type `op-type` in the current transaction. Each
  type's violations are read again just before its remedy, since an earlier
  remedy may have settled them. Returns the documents the operation bumped."
  [tx user cs doc base-ctx op-type]
  (let [project (:project_id (psc/q1 tx {:select [:project_id] :from :documents :where [:= :id doc]}))
        counts (atom {})
        result (binding [psaw/*expected-document-version* nil
                         psaw/*batch-validated-document-versions* nil
                         op/*custom-description* nil]
                 (op/submit-operation*
                  tx
                  {:type op-type
                   :project project
                   :document doc
                   :user user
                   :skip-lock-check? true
                   :description "Applied layer rules"}
                  (fn [tx]
                    (doseq [t remedy-order
                            c cs
                            :when (= t (:type c))]
                      (let [ctx (if (= :all (:mode base-ctx))
                                  (restrict-to-doc base-ctx doc)
                                  (restrict-to-doc (make-ctx tx @psaw/*pending*) doc))
                            vs (check-one ctx c)]
                        (when (seq vs)
                          (remedy! tx ctx c vs counts))))
                    (let [said (describe-counts @counts)]
                      (psc/execute! tx {:update :operations
                                        :set {:description (str (if (= op-type :layer/repair-constraints)
                                                                  "Repaired layer rules"
                                                                  "Applied layer rules")
                                                                (when (seq said) (str ": " said)))}
                                        :where [:= :id (:id psaw/*op*)]}))
                    @counts)))]
    (when-not (:success result)
      (throw (ex-info (str "Applying layer rules to document " doc " failed: " (:error result))
                      {:code 500})))
    {:documents (set (:documents result)) :counts (:extra result)}))

;; ============================================================
;; The end of a transaction
;; ============================================================

(defn- shared-batch-id!
  "The batch id the remedies' operations share with the write that caused
  them. Inside a batch it is the batch's. A single operation has none, so
  it gets one here, on its own row too: History reads a batch as one step
  and never shows the instant between a write and its remedies, when the
  rules were broken."
  [tx]
  (or op/*current-batch-id*
      (when-let [op-id (:id psaw/*op*)]
        (or (:batch_id (psc/q1 tx {:select [:batch_id] :from :operations :where [:= :id op-id]}))
            (let [bid (random-uuid)]
              (psc/execute! tx {:update :operations :set {:batch_id bid} :where [:= :id op-id]})
              bid)))
      (random-uuid)))

(defn finish!
  "Check the layer constraints the transaction's writes could break, at its
  end, inside it. Refuses (throws a 422 `refusal`) when a violation is
  direct or of a type with no remedy. Otherwise applies each structural
  violation's remedy, one `layer/apply-constraints` operation per document,
  and checks again: a violation left then is a bug (500). Returns the set of
  documents the remedies bumped.

  Cheap when nothing is declared: three reads of the layer tables."
  ([tx] (finish! tx (:user psaw/*op*)))
  ([tx user]
   (let [pending psaw/*pending*
         notes (some-> pending deref)]
     (if (empty? notes)
       #{}
       (let [docs (distinct (keep (comp u :doc) (vals notes)))
             layers (when (seq docs) (constrained-layers tx docs))]
         (if (empty? layers)
           #{}
           (let [cs (instances layers)
                 ctx (make-ctx tx notes)
                 vs (check-all ctx cs)]
             (if (empty? vs)
               #{}
               (let [refused (filter #(or (not (remediable (:type %))) (direct? ctx %)) vs)]
                 (when (seq refused)
                   (throw (refusal tx refused)))
                 (let [by-doc (group-by :document vs)
                       batch-id (shared-batch-id! tx)
                       bumped (binding [op/*current-batch-id* batch-id]
                                (into #{} (mapcat (fn [doc]
                                                    (:documents (remedy-document! tx user cs doc ctx
                                                                                  :layer/apply-constraints))))
                                      (sort-by str (keys by-doc))))
                       left (check-all (make-ctx tx @pending) cs)]
                   (when (seq left)
                     (log/error "Layer rules left violations after their remedies:" (pr-str (map wire left)))
                     (throw (ex-info "Layer rules left violations after their remedies." {:code 500})))
                   bumped))))))))))

(defn check-batch!
  "The atomic batch handler's hook: run `f` (the batch's operations) with the
  collector bound, then `finish!` before the transaction commits. A refusal
  becomes the batch's 422 answer. When a remedy bumped documents, the
  answer's X-Document-Versions is read again, so a strict client's next
  write is not refused for a version its own batch moved past."
  [tx user f]
  (binding [psaw/*pending* (atom {})]
    (let [response (f)
          bumped (try
                   (finish! tx user)
                   (catch ExceptionInfo e
                     (if-let [vs (:violations (ex-data e))]
                       (throw (ex-info "batch-failed"
                                       {:plaid.batch/failure
                                        {:status 422
                                         :body {:error (ex-message e)
                                                :violations vs
                                                :violation-count (:violation-count (ex-data e))}}}))
                       (throw e))))]
      (if (seq bumped)
        (let [header (get-in response [:headers "X-Document-Versions"])
              named (keys (some-> header (psc/read-json)))
              ids (distinct (concat (map (comp u name) named) bumped))
              versions (psc/document-versions tx ids)]
          (assoc-in response [:headers "X-Document-Versions"]
                    (psc/write-json (into {} (map (fn [[k v]] [(str k) v])) versions))))
        response))))

;; ============================================================
;; Whole-layer checks, for declarations, check and repair
;; ============================================================

(defn- layer-instances
  "The instances of the list `constraints` declared as `ns` on `layer`."
  [layer ns constraints]
  (for [c constraints] {:ns ns :type (get c "type") :params c :layer layer}))

(defn check-layer
  "Every violation, in the stored data of `layer`, of `constraints` (a
  validated list) under `ns`."
  [tx layer ns constraints]
  (check-all {:tx tx :mode :all} (layer-instances layer ns constraints)))

(defn repair-layer!
  "Apply the remedies of the remediable types in `constraints` to every
  violation in the stored data of `layer`, one `layer/repair-constraints`
  operation per document, or in `document` alone. The one kept is the
  smallest id, the others follow in id order, and their values are joined
  into it. A join a value-set stored on the layer refuses leaves that token
  as it is, so a repair deletes no value. A document
  another holds the lock on is left as it is and named under `:locked`.
  Returns {:repaired [...] :locked [...] :remaining [violations]}."
  [tx user layer ns constraints & {:keys [document]}]
  (let [cs (layer-instances layer ns constraints)
        fixable (filter #(remediable (:type %)) cs)
        scope (cond-> {:tx tx :mode :all} document (assoc :only-doc (u document)))
        vs (check-all scope fixable)
        docs (sort-by str (distinct (map :document vs)))
        held (into {} (keep (fn [doc]
                              (let [r (locks/check-document-locks [(u doc)] user)]
                                (when (map? r) [doc (:user-id r)]))))
                   docs)
        ctx (assoc scope :repair? true)
        repaired (vec (for [doc docs
                            :when (not (contains? held doc))
                            :let [{:keys [counts]} (remedy-document! tx user fixable doc ctx
                                                                     :layer/repair-constraints)]
                            [t entries] (group-by (comp first key) counts)]
                        {:document (str doc)
                         :constraint t
                         :deleted (reduce + 0 (keep (fn [[[_ _ verb _] n]] (when (= "deleted" verb) n)) entries))
                         :joined (reduce + 0 (keep (fn [[[_ _ verb _] n]] (when (= "joined" verb) n)) entries))}))]
    {:repaired repaired
     :locked (vec (for [[doc holder] (sort-by (comp str key) held)]
                    {:document (str doc) :locked-by holder}))
     :remaining (check-all scope cs)}))
