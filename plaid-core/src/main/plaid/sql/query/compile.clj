(ns plaid.sql.query.compile
  "Core compiler: a resolved query AST -> one HoneySQL map. Pure; no DB access.

  Structure: tables go in `:from` as a comma-join and every condition goes in a
  single AND-ed `:where` (SQLite/Postgres plan this identically to explicit INNER
  JOINs, and it keeps the compiler from juggling ON-clause placement).

  Three passes:
    A. scan entity clauses -> per-var constraints (layer-ids, value, doc, begin/end)
    B. for every var (incl. ones introduced only by relationships): allocate a table
       alias, emit its base table, and emit its SCOPE predicate — an `IN <layer-ids>`
       filter for layer-named vars, else a defense-in-depth join to the var's layer
       table filtered by `project_id IN scope`. THE ACL INVARIANT: no entity alias is
       emitted without a scope predicate (asserted at the end; a miss is a 500).
    C. relationship clauses + inline relation source/target -> join predicates.

  Token precedence is the canonical sort on `(begin, precedence)` (NULL precedence =
  COALESCE 0). `:precedes*` is a row-value `<`; `:precedes` binds the right token to
  the left's immediate successor via a correlated `ORDER BY … LIMIT 1` subquery —
  ~30× faster than a `NOT EXISTS`-between guard and correct for the composite key."
  (:require [clojure.set :as set]
            [plaid.query.ast :as ast]
            [plaid.sql.common :as psc]
            [plaid.sql.query.resolve :as qr]))

(def ^:private entity-table
  {:span :spans :token :tokens :relation :relations})

(def ^:private alias-prefix
  {:span "s" :token "t" :relation "r"})

(def ^:private layer-fk
  {:span :span_layer_id :token :token_layer_id :relation :relation_layer_id})

(def ^:private layer-tbl
  {:span :span_layers :token :token_layers :relation :relation_layers})

(defn- err-500! [msg data]
  (throw (ex-info msg (merge {:code 500 :query-error/stage :compile} data))))

;; ---------------------------------------------------------------------------
;; Mutable-ish compile state (a local atom; contained within compile-query)
;; ---------------------------------------------------------------------------

(defn- new-state [scope kinds]
  (atom {:n 0
         :scope (vec scope)
         :kinds kinds
         :var->alias {}
         :from []
         :where []
         :scoped #{}}))   ; entity vars that have received a scope predicate

(defn- next-alias! [st prefix]
  (let [n (:n (swap! st update :n inc))]
    (keyword (str prefix "_" n))))

(defn- col
  "Qualified column keyword: (col :s_1 :value) => :s_1.value"
  [alias c]
  (keyword (str (name alias) "." (name c))))

(defn- add-from! [st entry] (swap! st update :from conj entry))
(defn- add-where! [st pred] (when pred (swap! st update :where conj pred)))

;; ---------------------------------------------------------------------------
;; Pass A: collect per-var entity constraints
;; ---------------------------------------------------------------------------

(defn- collect-entity-constraints
  "Map of var -> merged constraint map (with ::qr/layer-ids, :value, :doc, …)
  drawn from its entity clause(s)."
  [where]
  (reduce
   (fn [acc clause]
     (let [[head v cmap] clause]
       (if (contains? entity-table head)
         (update acc v merge cmap)
         acc)))
   {} where))

;; ---------------------------------------------------------------------------
;; Pass B: ensure every var has a table + scope predicate + filters
;; ---------------------------------------------------------------------------

(defn- ensure-var!
  "Allocate (once) a table alias for var v, emit its base table, scope predicate,
  and any value/doc/begin/end filters from its entity constraints. Idempotent."
  [st v constraints]
  (let [kind (get-in @st [:kinds v])]
    (when (nil? kind)
      (err-500! (str "No inferred kind for var " v) {:var v}))
    (when-not (get-in @st [:var->alias v])
      (let [a (next-alias! st (alias-prefix kind))]
        (swap! st assoc-in [:var->alias v] a)
        (add-from! st [(entity-table kind) a])
        ;; --- scope predicate (THE ACL invariant) ---
        (let [cs (get constraints v)
              layer-ids (::qr/layer-ids cs)]
          (if (seq layer-ids)
            (add-where! st [:in (col a (layer-fk kind)) (vec layer-ids)])
            ;; defense-in-depth: join the var's layer table, filter project_id IN scope
            (let [lt (next-alias! st "lt")]
              (add-from! st [(layer-tbl kind) lt])
              (add-where! st [:= (col a (layer-fk kind)) (col lt :id)])
              (add-where! st [:in (col lt :project_id) (:scope @st)])))
          (swap! st update :scoped conj v)
          ;; --- non-scope filters ---
          (when (contains? cs :value)
            (add-where! st [:= (col a :value) (psc/write-json (:value cs))]))
          (when (contains? cs :doc)
            (add-where! st [:= (col a :document_id) (str (:doc cs))]))
          (when (contains? cs :begin)
            (add-where! st [:= (col a :begin) (:begin cs)]))
          (when (contains? cs :end)
            (add-where! st [:= (col a :end_) (:end cs)])))))
    (get-in @st [:var->alias v])))

;; ---------------------------------------------------------------------------
;; Pass C: relationship predicates
;; ---------------------------------------------------------------------------

(defn- token-key
  "Row-value (begin, COALESCE(precedence,0)) for token alias a — the canonical
  precedence sort key."
  [a]
  [:composite (col a :begin) [:coalesce (col a :precedence) 0]])

(defn- successor-subquery
  "Correlated subquery returning the id of the token immediately after `t1` in
  (begin, precedence) order within the same text+layer."
  [st t1]
  (let [pt (next-alias! st "pt")]
    {:select [(col pt :id)]
     :from [[:tokens pt]]
     :where [:and
             [:= (col pt :text_id) (col t1 :text_id)]
             [:= (col pt :token_layer_id) (col t1 :token_layer_id)]
             [:> (token-key pt) (token-key t1)]]
     :order-by [(col pt :begin) [[:coalesce (col pt :precedence) 0]]]
     :limit 1}))

(defn- compile-rel!
  [st constraints clause]
  (let [[head a b] clause
        av #(ensure-var! st % constraints)]
    (case head
      :covers   (let [s (av a) t (av b)
                      stj (next-alias! st "st")]
                  (add-from! st [:span_tokens stj])
                  (add-where! st [:= (col stj :span_id) (col s :id)])
                  (add-where! st [:= (col stj :token_id) (col t :id)]))
      :precedes  (let [t1 (av a) t2 (av b)]
                   (add-where! st [:= (col t2 :id) (successor-subquery st t1)]))
      :precedes* (let [t1 (av a) t2 (av b)]
                   (add-where! st [:and
                                   [:= (col t1 :text_id) (col t2 :text_id)]
                                   [:= (col t1 :token_layer_id) (col t2 :token_layer_id)]
                                   [:< (token-key t1) (token-key t2)]]))
      :source   (let [r (av a) s (av b)]
                  (add-where! st [:= (col r :source_span_id) (col s :id)]))
      :target   (let [r (av a) s (av b)]
                  (add-where! st [:= (col r :target_span_id) (col s :id)]))
      (err-500! (str "Compiler reached unknown relationship clause :" (name head)) {:clause clause}))))

(defn- compile-relation-inline!
  "A :relation entity clause may carry inline :source/:target span vars — compile
  them as relationship predicates."
  [st constraints clause]
  (let [[head r cmap] clause]
    (when (= head :relation)
      (let [ra (ensure-var! st r constraints)]
        (when-let [s (:source cmap)]
          (add-where! st [:= (col ra :source_span_id) (col (ensure-var! st s constraints) :id)]))
        (when-let [t (:target cmap)]
          (add-where! st [:= (col ra :target_span_id) (col (ensure-var! st t constraints) :id)]))))))

;; ---------------------------------------------------------------------------
;; Assemble
;; ---------------------------------------------------------------------------

(defn- find-select [st find-vars]
  (mapv (fn [v]
          (let [a (get-in @st [:var->alias v])]
            (when (nil? a) (err-500! (str "Find var " v " was never bound to a table") {:var v}))
            [(col a :id) (keyword (subs (name v) 1))]))
        find-vars))

(defn- assert-acl-invariant! [st]
  (let [entity-vars (->> (:kinds @st) (filter (fn [[_ k]] (contains? entity-table k))) (map key) set)
        unscoped (set/difference entity-vars (:scoped @st))]
    (when (seq unscoped)
      (err-500! (str "ACL invariant violated: entity vars without a scope predicate: " (vec unscoped))
                {:vars (vec unscoped)}))))

(defn compile-query
  "Resolved AST -> HoneySQL map. Throws 500 only on internal invariant failures."
  [resolved]
  (let [scope (::qr/scope resolved)
        kinds (ast/infer-kinds resolved)
        st (new-state scope kinds)
        constraints (collect-entity-constraints (:where resolved))]
    ;; Pass B: every var (entity + relationship-introduced) gets a table + scope.
    (doseq [v (keys kinds)] (ensure-var! st v constraints))
    ;; Pass C: relationship clauses + inline relation source/target.
    (doseq [clause (:where resolved)]
      (cond
        (contains? entity-table (first clause)) (compile-relation-inline! st constraints clause)
        :else (compile-rel! st constraints clause)))
    (assert-acl-invariant! st)
    (cond-> {:select-distinct (find-select st (:find resolved))
             :from (:from @st)
             :where (into [:and] (:where @st))}
      (:limit resolved) (assoc :limit (:limit resolved)))))
