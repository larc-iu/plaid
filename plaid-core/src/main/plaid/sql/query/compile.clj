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

  Token precedence is the canonical total order on `(begin, precedence, end, id)`,
  with `precedence` sorting NULLS LAST (precedence outranks extent). `:precedes*` is
  a row-value `<` on that key; `:precedes` binds the right token to the left's
  immediate successor via a correlated `ORDER BY … LIMIT 1` subquery — ~30× faster
  than a `NOT EXISTS`-between guard and correct for the composite key. The `end`/`id`
  tail makes the order total, so adjacency is well-defined even among tokens that
  share a begin offset."
  (:require [clojure.set :as set]
            [plaid.query.ast :as ast]
            [plaid.sql.common :as psc]
            [plaid.sql.query.resolve :as qr]))

(def ^:private entity-table
  {:span :spans :token :tokens :relation :relations :vocab :vocab_items})

(def ^:private alias-prefix
  {:span "s" :token "t" :relation "r" :vocab "v"})

(def ^:private layer-fk
  {:span :span_layer_id :token :token_layer_id :relation :relation_layer_id :vocab :vocab_layer_id})

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
  "Map of var -> VECTOR of the constraint maps from its entity clause(s). Each
  clause contributes its own map and the compiler ANDs them all: a var that
  appears in two entity clauses must satisfy both. (Merging them last-wins would
  silently drop the earlier constraint and return a wrong, larger result — e.g.
  `value NOUN` AND `value VERB` must be unsatisfiable, not just `VERB`.)"
  [where]
  (reduce
   (fn [acc clause]
     (let [[head v cmap] clause]
       (if (contains? entity-table head)
         (update acc v (fnil conj []) cmap)
         acc)))
   {} where))

;; ---------------------------------------------------------------------------
;; Pass B: ensure every var has a table + scope predicate + filters
;; ---------------------------------------------------------------------------

(defn- atomic-pred
  "`= literal` for a scalar value, `IN (…)` for a vector (value alternation).
  `enc` encodes each literal to its stored form."
  [col v enc]
  (if (vector? v)
    [:in col (mapv enc v)]
    [:= col (enc v)]))

(defn- ensure-var!
  "Allocate (once) a table alias for var v, emit its base table, scope predicate,
  and the value/doc/begin/end filters from ALL its entity constraint maps (ANDed).
  `constraints` maps var -> vector of constraint maps. Idempotent."
  [st v constraints]
  (let [kind (get-in @st [:kinds v])]
    (when (nil? kind)
      (err-500! (str "No inferred kind for var " v) {:var v}))
    (when-not (get-in @st [:var->alias v])
      (let [a (next-alias! st (alias-prefix kind))]
        (swap! st assoc-in [:var->alias v] a)
        (add-from! st [(entity-table kind) a])
        ;; --- scope predicate (THE ACL invariant) ---
        (let [cmaps (get constraints v)                 ; vector of constraint maps (may be nil)
              layer-id-sets (keep ::qr/layer-ids cmaps)] ; one per layer-named clause
          (cond
            ;; a layer-named clause already pins scope; AND one IN per such clause
            (seq layer-id-sets)
            (doseq [ids layer-id-sets]
              (add-where! st [:in (col a (layer-fk kind)) (vec ids)]))
            ;; vocab layers are global — scope via project_vocabs grants
            (= kind :vocab)
            (let [pv (next-alias! st "pv")]
              (add-from! st [:project_vocabs pv])
              (add-where! st [:= (col a :vocab_layer_id) (col pv :vocab_layer_id)])
              (add-where! st [:in (col pv :project_id) (:scope @st)]))
            ;; defense-in-depth: join the var's layer table, filter project_id IN scope
            :else
            (let [lt-table (or (layer-tbl kind)
                               (err-500! (str "No layer table registered for kind " kind
                                              " — keep entity-table/alias-prefix/layer-fk/layer-tbl in sync")
                                         {:kind kind}))
                  lt (next-alias! st "lt")]
              (add-from! st [lt-table lt])
              (add-where! st [:= (col a (layer-fk kind)) (col lt :id)])
              (add-where! st [:in (col lt :project_id) (:scope @st)])))
          (swap! st update :scoped conj v)
          ;; --- non-scope filters, ANDed across every clause on this var ---
          (doseq [cs cmaps]
            (when (contains? cs :value)
              (add-where! st (atomic-pred (col a :value) (:value cs) psc/write-json)))
            (when (contains? cs :form)          ; vocab_items.form — plain TEXT, not JSON
              (add-where! st (atomic-pred (col a :form) (:form cs) identity)))
            (when (contains? cs :doc)
              (add-where! st (atomic-pred (col a :document_id) (:doc cs) str)))
            (when (contains? cs :begin)
              (add-where! st (atomic-pred (col a :begin) (:begin cs) identity)))
            (when (contains? cs :end)
              (add-where! st (atomic-pred (col a :end_) (:end cs) identity)))))))
    (get-in @st [:var->alias v])))

;; ---------------------------------------------------------------------------
;; Pass C: relationship predicates
;; ---------------------------------------------------------------------------

(defn- token-key
  "Row-value for the canonical token order `(begin, precedence, end, id)` with
  precedence NULLS LAST. The NULLS-LAST rank is encoded as a leading null-flag
  column (0 = present, 1 = NULL) so the whole tuple is non-NULL and SQL row-value
  comparison is well-defined; the `end`/`id` tail makes the order total.

  LOCKSTEP: `successor-subquery`'s ORDER BY expresses this SAME order with native
  `:asc-nulls-last`. The two encodings (this null-flag composite for the `>`
  filter, that ORDER BY for the `LIMIT 1` pick) must stay equivalent or
  `:precedes` selects the wrong successor — change them together."
  [a]
  [:composite
   (col a :begin)
   [:case [:is (col a :precedence) nil] 1 :else 0]
   [:coalesce (col a :precedence) 0]
   (col a :end_)
   (col a :id)])

(defn- precedes*-pred
  "Row-value `<` on (begin, precedence) within the same text+layer: t1 is
  strictly earlier than t2 in canonical token order."
  [t1 t2]
  [:and
   [:= (col t1 :text_id) (col t2 :text_id)]
   [:= (col t1 :token_layer_id) (col t2 :token_layer_id)]
   [:< (token-key t1) (token-key t2)]])

(defn- within-pred
  "Offset containment: `child`'s extent sits inside `parent`'s, same text, and
  they are distinct tokens. This is the token-hierarchy relation (derived purely
  from offsets). Containment is non-strict on the offsets so an equal-extent
  child (e.g. a full-width morpheme) still counts as within its parent; the
  `id <> id` guard keeps a token from being `within` (or `first-in`) itself when
  child and parent resolve to the same layer."
  [child parent]
  [:and
   [:<> (col child :id) (col parent :id)]
   [:= (col child :text_id) (col parent :text_id)]
   [:<= (col parent :begin) (col child :begin)]
   [:<= (col child :end_) (col parent :end_)]])

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
     :order-by [[(col pt :begin) :asc]
                [(col pt :precedence) :asc-nulls-last]
                [(col pt :end_) :asc]
                [(col pt :id) :asc]]
     :limit 1}))

(defn- first-in-subquery
  "Correlated EXISTS body: a token of `t`'s own layer that is also within
  `container` and strictly precedes `t`. `:first-in` asserts NOT EXISTS of this."
  [st t container]
  (let [fi (next-alias! st "fi")]
    {:select [1]
     :from [[:tokens fi]]
     :where [:and
             [:= (col fi :token_layer_id) (col t :token_layer_id)]
             (within-pred fi container)
             (precedes*-pred fi t)]}))

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
                   (add-where! st (precedes*-pred t1 t2)))
      :within    (let [c (av a) p (av b)]
                   (add-where! st (within-pred c p)))
      :first-in  (let [t (av a) cont (av b)]
                   (add-where! st (within-pred t cont))
                   (add-where! st [:not [:exists (first-in-subquery st t cont)]]))
      :source   (let [r (av a) s (av b)]
                  (add-where! st [:= (col r :source_span_id) (col s :id)]))
      :target   (let [r (av a) s (av b)]
                  (add-where! st [:= (col r :target_span_id) (col s :id)]))
      :vocab-link (let [t (av a) v (av b)
                        vl (next-alias! st "vl")
                        vlt (next-alias! st "vlt")]
                    (add-from! st [:vocab_links vl])
                    (add-from! st [:vocab_link_tokens vlt])
                    (add-where! st [:= (col vlt :token_id) (col t :id)])
                    (add-where! st [:= (col vlt :vocab_link_id) (col vl :id)])
                    (add-where! st [:= (col vl :vocab_item_id) (col v :id)]))
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
        ;; validate already inferred + attached the var-kinds; reuse it (fall back
        ;; to re-inferring if a caller hands us an AST that skipped validate).
        kinds (or (::ast/var-kinds resolved) (ast/infer-kinds resolved))
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
