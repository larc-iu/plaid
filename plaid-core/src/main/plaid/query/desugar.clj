(ns plaid.query.desugar
  "Desugaring: `:seq`, `:or` and `:not` expanded into plain conjunctive
  branches, which the executor UNIONs.

  `:seq` (CQP-style token sequences) unrolls into `:token` + `:covers` +
  `:precedes` clauses, one alternative per bounded-quantifier length combo;
  `:or` distributes to DNF; a `:not` body is expanded and De-Morganed so the
  outer query does not branch. `expand-where` is the entry, and the two
  `check-*!` functions are the cross-branch checks that only apply once a
  query has more than one branch.

  Called by `plaid.query.ast/expand`."
  (:refer-clojure :exclude [var?])
  (:require [clojure.set :as set]
            [plaid.query.clauses :as clauses :refer [err! var?]]))

;; ---------------------------------------------------------------------------
;; :seq desugaring -> one or more branch queries (UNIONed downstream)
;; ---------------------------------------------------------------------------

(def ^:private bounded-rep-max 16)
(def ^:private query-branch-cap
  "Max conjunctive branches a query may expand to (the cartesian product of every
  :or group count and :seq quantifier-combo count). UNIONed downstream."
  128)

(defn- seq-clause? [c] (= :seq (first c)))
(defn- or-clause? [c] (= :or (first c)))
(defn- seq-atom? [elem] (contains? clauses/entity-clauses (first elem)))
(defn- seq-element-atom [elem] (if (seq-atom? elem) elem (last elem)))

(defn- element-counts
  "Allowed occurrence counts for a seq element (bounded only)."
  [elem]
  (cond
    (seq-atom? elem) [1]
    (= :? (first elem)) [0 1]
    (#{:* :+} (first elem))
    (err! :validate (str "Unbounded seq quantifier :" (clojure.core/name (first elem))
                         " is not supported in v0 — use a bounded :rep [n m]"))
    (= :rep (first elem))
    (let [[_ n m] elem]
      (when-not (and (integer? n) (integer? m) (<= 0 n m) (<= m bounded-rep-max))
        (err! :validate (str ":rep bounds must be integers 0 <= n <= m <= " bounded-rep-max
                             ", got [" n " " m "]")))
      (vec (range n (inc m))))
    :else (err! :validate (str "Unknown seq quantifier in " (pr-str elem)))))

(defn- validate-seq-atom!
  [atom quantified?]
  (let [[head cmap & more] atom
        named? (= :as (first more))]
    (when-not (#{:span :token} head)
      (err! :validate (str "seq elements must be :span or :token patterns, got :" (clojure.core/name head))))
    (when (and quantified? named?)
      (err! :validate "Quantified seq elements cannot be named with :as (only fixed elements may bind a :find var)"))
    (when (and named? (not (var? (second more))))
      (err! :validate (str "seq :as must be followed by a var, got: " (pr-str (second more)))))
    (let [allowed (clauses/entity-clauses head)
          unknown (remove allowed (keys (or cmap {})))]
      (when (seq unknown)
        (err! :validate (str "Unknown constraint key(s) " (vec unknown) " in seq :" (clojure.core/name head) " element"))))
    ;; The seq config owns the document, and the token layer the sequence walks.
    ;; `atom->clauses` writes both onto every desugared token bind, so an element
    ;; that carried its own would be overwritten (a :token element) or contradicted
    ;; (a :span element pinned to another document). Refuse both rather than
    ;; returning nothing or silently ignoring what was written.
    (when (contains? cmap :doc)
      (err! :validate (str "A seq element takes no :doc. The document belongs to the seq config: "
                           "[\"seq\", {\"layer\": …, \"doc\": …}, …]")))
    (when (and (= head :token) (contains? cmap :layer))
      (err! :validate (str "A seq :token element takes no :layer. The token layer the sequence walks "
                           "belongs to the seq config: [\"seq\", {\"layer\": …}, …]. "
                           "(A :span element's :layer is its own span layer and is kept.)")))))

(defn- cartesian
  "All combinations choosing one item from each collection, as vectors in order."
  [colls]
  (reduce (fn [acc coll] (vec (for [a acc c coll] (conj a c)))) [[]] colls))

(defn- fresh! [counter prefix] (symbol (str "?__" prefix (swap! counter inc))))

(defn- atom->clauses
  "Base clauses binding one atom-occurrence to a token in `seq-layer` (and, when
  the seq config carries `:doc`, pinned to that document). Returns [clauses
  token-var]."
  [atom seq-layer seq-doc counter]
  (let [[head cmap & more] atom
        named (when (= :as (first more)) (second more))
        tok-cmap (fn [base] (cond-> base seq-doc (assoc :doc seq-doc)))]
    (case head
      :token (let [tv (or named (fresh! counter "seqt"))]
               [[[:token tv (tok-cmap (assoc cmap :layer seq-layer))]] tv])
      :span  (let [tv (fresh! counter "seqt")
                   sv (or named (fresh! counter "seqs"))]
               [[[:span sv cmap] [:covers sv tv] [:token tv (tok-cmap {:layer seq-layer})]] tv]))))

(defn- seq-fragment
  "Desugar one seq clause under a chosen per-element count combo into base
  clauses: per-occurrence token binds (+ covering span) chained by :precedes."
  [config elements counts counter]
  (let [seq-layer (:layer config)
        seq-doc (:doc config)
        atoms (mapcat (fn [elem cnt] (repeat cnt (seq-element-atom elem))) elements counts)
        pairs (mapv #(atom->clauses % seq-layer seq-doc counter) atoms)
        clauses (vec (mapcat first pairs))
        tvars (mapv second pairs)]
    (into clauses (map (fn [a b] [:precedes a b]) tvars (rest tvars)))))

(defn- seq-alternatives
  "Validate one :seq clause and return its alternatives — a vector of conjunctive
  clause-lists, one per bounded-quantifier length combo. `counter` is the shared
  fresh-var counter (unique across the whole query so alternatives never collide
  when combined into a branch)."
  [sc counter]
  (let [[_ config & elements] sc]
    (when-not (:layer config)
      (err! :validate ":seq requires a :layer in its config map"))
    (let [bad (remove #{:layer :doc} (keys config))]
      (when (seq bad)
        (err! :validate (str ":seq config has unknown key(s) " (vec bad) " (allowed: :layer, :doc)"))))
    (when (empty? elements)
      (err! :validate ":seq needs at least one element"))
    (doseq [e elements]
      (validate-seq-atom! (seq-element-atom e) (not (seq-atom? e))))
    (mapv (fn [combo] (seq-fragment config (vec elements) combo counter))
          (cartesian (mapv element-counts elements)))))

(declare expand-clauses)

(defn- not-clause? [c] (= :not (first c)))

(defn- expand-clause
  "The alternatives (a vector of conjunctive clause-lists) one clause contributes:
  a static clause is itself (one alternative); a :seq is one alternative per
  quantifier combo; an :or is the union of each group's expansions; a :not has
  its BODY expanded and De-Morganed — NOT(b1 OR b2 …) = NOT(b1) AND NOT(b2) …, so
  it yields ONE alternative (a conjunction of simple :nots), leaving any nested
  :not in place for the compiler to emit as a nested NOT EXISTS."
  [clause counter]
  (cond
    (seq-clause? clause) (seq-alternatives clause counter)
    (or-clause? clause)
    (let [groups (rest clause)]
      (when (< (count groups) 2)
        (err! :validate ":or needs at least 2 groups"))
      (doseq [g groups]
        (when-not (and (sequential? g) (seq g))
          (err! :validate "each :or group must be a non-empty list of clauses")))
      (vec (mapcat #(expand-clauses % counter) groups)))
    (not-clause? clause)
    (let [body-branches (expand-clauses (vec (rest clause)) counter)]
      [(mapv #(into [:not] %) body-branches)])
    :else [[clause]]))

(defn- expand-clauses
  "Expand a clause list (possibly containing :seq/:or) into a vector of
  conjunctive branch clause-lists, multiplying branches at each disjunctive
  point. `[c [:or [A] [B]] d]` -> `[[c A d] [c B d]]` (distributes to DNF)."
  [clauses counter]
  (reduce
   (fn [branches clause]
     (let [alts (expand-clause clause counter)
           next-branches (vec (for [b branches alt alts] (into b alt)))]
       (when (> (count next-branches) query-branch-cap)
         (err! :validate (str "Query expands to more than " query-branch-cap
                              " branches — reduce :or / :seq disjunction")))
       next-branches))
   [[]]
   clauses))

(defn expand-where
  "Expand a :where (possibly with :seq/:or) into one or more conjunctive branch
  :where vectors (UNIONed downstream). No disjunction -> a single branch equal to
  the input."
  [where]
  (expand-clauses (vec where) (atom 0)))

(defn check-branch-consistency!
  "Cross-branch checks for a query that expanded to >1 branch (via :or/:seq):
  every :find var must be bound in EVERY branch (so the UNION columns are always
  populated) and have the SAME kind across branches (so a result column is one
  entity type and :entities hydrates each row with the right reader)."
  [branch-wheres find-vars]
  (let [branch-kinds (mapv (fn [w] (clauses/infer-kinds {:where w})) branch-wheres)]
    (doseq [v find-vars]
      (when-not (every? #(contains? % v) branch-kinds)
        (err! :validate (str "Find var " v " is not bound in every branch — each :or alternative must bind it")
              {:var v}))
      (let [ks (distinct (map #(get % v) branch-kinds))]
        (when (> (count ks) 1)
          (err! :validate (str "Find var " v " has inconsistent kinds across branches: " (vec ks)
                               " — every branch must bind it to the same entity kind")
                {:var v :kinds (vec ks)}))))))

(defn aggregate-branch-entities
  "Under aggregation, the distinct-match key projects EVERY entity/layer var's
  id, so a UNION's branches must project the same columns in the same order.
  This is the union of those vars across the branches: a branch that does not
  bind one projects NULL in its column (`aggregate-projection`), so branches
  that bind different variables can still be unioned. Sorted by name, which is
  the order the columns are emitted in."
  [branch-wheres]
  ;; Compare the vars actually PROJECTED per branch: positive (non-:not) entity/
  ;; layer vars — exactly the ids the distinct-match key emits. Keying off
  ;; `clauses/infer-kinds` instead would fold in `:not`-existential vars, so a var that is
  ;; positive in one branch but only inside a `:not` in another would look equal
  ;; here yet project a different column count -> a UNION-arity 500.
  (let [entity-sets (mapv (fn [w]
                            (let [kinds (clauses/infer-kinds {:where w})]
                              (set (remove #(= :scalar (get kinds %)) (clauses/positive-binding-vars w)))))
                          branch-wheres)]
    (vec (sort-by name (apply set/union entity-sets)))))


