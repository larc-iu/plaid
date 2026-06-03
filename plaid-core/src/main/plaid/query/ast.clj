(ns plaid.query.ast
  "Backend-agnostic query AST for the Plaid query language.

  Owns the wire dialect (`parse`: JSON-ish map -> canonical EDN AST), validation
  (`validate`: shape + clause arity + var-kind inference + safety), and the small
  vocabulary of clause kinds. Knows NOTHING about SQL or the database — it is the
  one place that turns an untrusted request body into a checked, canonical AST.

  Every author-facing problem is thrown as `(ex-info msg {:code 400 ...})`, matching
  the `:code`->HTTP convention used throughout `plaid.rest-api.v1`.

  Canonical AST shape:
    {:find   [?s1 ?s2]            ; non-empty vector of vars (symbols starting with ?)
     :where  [[:span ?s1 {:layer \"pos\" :value \"NOUN\"}] ...]
     :scope  {:projects [...]}    ; optional; :projects (names) and/or :project-ids
     :limit  100                  ; optional positive int
     :return :ids}                ; defaulted to :ids

  Vars are Clojure symbols beginning with `?` (e.g. `?s1`). JSON sends them as the
  strings \"?s1\"; `parse` converts.

  This namespace covers the v0 (M0+M1) clause set. Clauses recognized but reserved
  for later milestones (`:within`, `:first-in`, `:vocab`, `:vocab-link`, `:seq`) are
  rejected by `validate` with a clear \"not yet supported\" message, and `:as-of` is
  rejected as the bitemporal seam."
  (:refer-clojure :exclude [var?])
  (:require [clojure.string :as str]))

;; ---------------------------------------------------------------------------
;; Vars
;; ---------------------------------------------------------------------------

(defn var?
  "True if x is a query variable: a symbol whose name starts with `?`."
  [x]
  (and (symbol? x) (str/starts-with? (name x) "?")))

(defn ->var
  "Coerce a var token (symbol or `\"?x\"` string) to a canonical var symbol.
  Returns non-vars unchanged (so constraint scalars pass through)."
  [x]
  (cond
    (var? x) x
    (and (string? x) (str/starts-with? x "?")) (symbol x)
    :else x))

;; ---------------------------------------------------------------------------
;; Clause vocabulary
;; ---------------------------------------------------------------------------

;; Entity clauses: [:kind ?var {constraint-map}]. Value = set of allowed constraint keys.
(def ^:private entity-clauses
  {:span     #{:layer :value :doc}
   :token    #{:layer :doc :begin :end}
   :relation #{:layer :value :doc :source :target}
   :vocab    #{:layer :form}})

;; Constraint keys whose value may be a vector = "one of" (compiles to IN). The
;; literal-match keys only — NOT :layer (multi-layer is unique-or-400 / future
;; layer vars) or :source/:target (vars).
(def ^:private alternation-keys #{:value :form :doc :begin :end})

;; Constraint keys whose value may be a regex spec `{:regex "..." :flags "i"?}`
;; (compiles to a REGEXP match). Text-valued keys only.
(def ^:private regex-keys #{:value :form})
(def ^:private regex-max-len 512)

;; Layer-constraint clauses: [:span-layer ?sl {constraint-map}]. The head IS the
;; layer kind; binds/constrains a LAYER variable. Value = allowed constraint keys.
(def ^:private layer-clauses
  {:span-layer     #{:name :alias}
   :token-layer    #{:name :alias}
   :relation-layer #{:name :alias}
   :vocab-layer    #{:name :alias}})

;; Relationship clauses and their arity (number of var args after the head).
(def ^:private rel-clauses
  {:covers     2     ; [:covers ?span ?token]
   :precedes   2     ; [:precedes ?t1 ?t2]      immediate
   :precedes*  2     ; [:precedes* ?t1 ?t2]     transitive
   :source     2     ; [:source ?rel ?span]
   :target     2     ; [:target ?rel ?span]
   :within     2     ; [:within ?child ?parent] offset containment
   :first-in   2     ; [:first-in ?token ?container]
   :vocab-link 2})   ; [:vocab-link ?token ?vocab]

;; Clause heads accepted by the grammar but not implemented until a later
;; milestone. Rejected by validate with a "not yet supported" message rather
;; than an "unknown clause" one, so the surface stays forward-compatible.
;; (Empty now that :seq landed in M3 — the mechanism is retained for the next
;; deferral.)
(def ^:private deferred-clauses
  #{})

;; Attributes a :find var of each kind may be ORDER BY'd on. Backend-agnostic
;; domain set; the compiler maps each to a column. Only :find vars are orderable
;; (they are bound in every UNION branch, so the sort column is always present).
(def ^:private order-attrs
  {:span     #{:value :doc :id}
   :token    #{:begin :end :precedence :doc :id}
   :relation #{:value :doc :id}
   :vocab    #{:form :id}})

;; ---------------------------------------------------------------------------
;; Errors
;; ---------------------------------------------------------------------------

(defn- err!
  ([stage msg] (err! stage msg {}))
  ([stage msg data]
   (throw (ex-info msg (merge {:code 400 :query-error/stage stage} data)))))

;; ---------------------------------------------------------------------------
;; Parse: tolerant JSON-ish map -> canonical EDN AST
;; ---------------------------------------------------------------------------

(defn- ->kw
  "Normalize a key/head token to a keyword. Accepts keyword or string
  (with or without a leading colon)."
  [x]
  (cond
    (keyword? x) x
    (string? x) (keyword (if (str/starts-with? x ":") (subs x 1) x))
    :else (err! :parse (str "Expected a keyword or string, got: " (pr-str x)))))

(defn- normalize-constraints
  "Constraint map: keyword-ize keys, and var-ize the keys whose values may be a
  query variable — `:source`/`:target` (inline relation endpoints) and `:layer`
  (a layer variable). `->var` only coerces strings that actually look like vars
  (`\"?x\"`), so a literal layer ref (`\"pos\"`) or a literal gloss (`\"?\"`)
  stays a string. Every other value (`:value` `:form` `:doc` `:begin` `:end`) is
  left untouched."
  [m]
  (when-not (map? m)
    (err! :parse (str "Clause constraint must be a map, got: " (pr-str m))))
  (reduce-kv (fn [acc k v]
               (let [k (->kw k)]
                 (assoc acc k (cond
                                (#{:source :target :layer} k) (->var v)
                                ;; a map value is a regex spec — keyword-ize its keys
                                (map? v) (reduce-kv (fn [a ik iv] (assoc a (->kw ik) iv)) {} v)
                                :else v))))
             {} m))

;; --- :seq sugar (CQP-style token sequences) --------------------------------
;; A :seq clause walks one token layer; each element is a span/token pattern
;; over a token in that layer, with immediate-:precedes adjacency between
;; elements. Quantifiers `:?` / `:rep n m` are bounded and unroll downstream
;; (see `expand`); `:*` / `:+` parse but are rejected at validation.

(defn- normalize-seq-atom
  "Normalize a seq element atom: [:span {cmap}] or [:span {cmap} :as ?v]."
  [head args]
  (when-not (map? (first args))
    (err! :parse (str "seq " (clojure.core/name head) " element needs a constraint map")))
  (let [cmap (normalize-constraints (first args))
        more (rest args)
        named (when (seq more)
                (if (= :as (->kw (first more)))
                  (->var (second more))
                  (err! :parse (str "Unexpected token in seq element after constraints: "
                                    (pr-str (first more))))))]
    (cond-> [head cmap] named (conj :as named))))

(defn- normalize-seq-element
  [elem]
  (when-not (and (sequential? elem) (seq elem))
    (err! :parse (str "Each seq element must be a non-empty vector, got: " (pr-str elem))))
  (let [head (->kw (first elem))]
    (cond
      (#{:? :* :+} head) [head (normalize-seq-element (second elem))]
      (= :rep head)      (let [[_ n m inner] elem] [:rep n m (normalize-seq-element inner)])
      :else              (normalize-seq-atom head (rest elem)))))

(declare normalize-clause)

(defn- normalize-or-clause
  "Normalize an [:or group ...] clause; each group is a list of clauses (its own
  conjunction). Clauses are normalized recursively, so groups may nest :or/:seq."
  [groups]
  (into [:or]
        (map (fn [g]
               (when-not (sequential? g)
                 (err! :parse (str "Each :or group must be a list of clauses, got: " (pr-str g))))
               (mapv normalize-clause g)))
        groups))

(defn- normalize-not-clause
  "Normalize a [:not clause ...] clause; the negated sub-pattern is the
  conjunction of the given clauses (normalized recursively)."
  [clauses]
  (into [:not] (map normalize-clause clauses)))

(defn- normalize-seq-clause
  "Normalize a [:seq {config} elem ...] clause."
  [args]
  (when-not (map? (first args))
    (err! :parse "A :seq clause needs a config map (with at least :layer) as its first argument"))
  (into [:seq (normalize-constraints (first args))]
        (map normalize-seq-element (rest args))))

(defn- normalize-clause
  [clause]
  (when-not (and (sequential? clause) (seq clause))
    (err! :parse (str "Each :where clause must be a non-empty vector, got: " (pr-str clause))))
  (let [head (->kw (first clause))]
    (cond
      (= head :seq) (normalize-seq-clause (rest clause))
      (= head :or)  (normalize-or-clause (rest clause))
      (= head :not) (normalize-not-clause (rest clause))
      :else (into [head]
                  (map (fn [a] (if (map? a) (normalize-constraints a) (->var a))))
                  (rest clause)))))

(defn- normalize-order-spec
  "Canonicalize one :order-by entry to `[?var :attr :dir]` (dir defaults :asc)."
  [spec]
  (when-not (and (sequential? spec) (<= 2 (count spec) 3))
    (err! :parse (str "Each :order-by entry must be [var attr] or [var attr dir], got: " (pr-str spec))))
  (let [[v attr dir] spec]
    [(->var v) (->kw attr) (if (nil? dir) :asc (->kw dir))]))

(defn parse
  "Normalize a raw request map (string- or keyword-keyed; JSON or EDN dialect)
  into the canonical EDN AST. Pure; does not validate semantics beyond the
  shape needed to normalize. Throws `:code 400` on gross malformation."
  [raw]
  (when-not (map? raw)
    (err! :parse (str "Query must be a map/object, got: " (pr-str raw))))
  (let [m (reduce-kv (fn [acc k v] (assoc acc (->kw k) v)) {} raw)]
    (cond-> {}
      (contains? m :find)   (assoc :find (mapv ->var (:find m)))
      (contains? m :where)  (assoc :where (mapv normalize-clause (:where m)))
      (contains? m :scope)  (assoc :scope (let [s (reduce-kv (fn [a k v] (assoc a (->kw k) v)) {} (:scope m))]
                                            s))
      (contains? m :limit)  (assoc :limit (:limit m))
      (contains? m :order-by) (assoc :order-by (let [ob (:order-by m)]
                                                 (when-not (sequential? ob)
                                                   (err! :parse (str ":order-by must be a list of [var attr dir] entries, got: " (pr-str ob))))
                                                 (mapv normalize-order-spec ob)))
      (contains? m :return) (assoc :return (->kw (:return m)))
      (contains? m :strict-layers) (assoc :strict-layers (:strict-layers m))
      (contains? m :as-of)  (assoc :as-of (:as-of m)))))     ; carried so validate can reject it

;; ---------------------------------------------------------------------------
;; Kind inference (backend-agnostic; domain concept, not SQL)
;; ---------------------------------------------------------------------------

(defn- assoc-kind
  "Record that `v` is of kind `k`, erroring on a conflicting prior kind."
  [kinds v k]
  (when-not (var? v)
    (err! :validate (str "Expected a var where one is required, got: " (pr-str v))))
  (if-let [prev (get kinds v)]
    (if (= prev k)
      kinds
      (err! :validate (str "Var " v " is used as both " (name prev) " and " (name k))
            {:var v}))
    (assoc kinds v k)))

;; A var in an entity's :layer position is a LAYER variable, of the matching
;; layer kind. Naming the layer lets two entities share it (a same-layer join)
;; and lets it be returned/constrained.
(def ^:private entity->layer-kind
  {:span :span-layer :token :token-layer :relation :relation-layer :vocab :vocab-layer})

(defn- clause-kinds
  "The (var -> kind) bindings a single clause asserts."
  [kinds clause]
  (let [[head & args] clause]
    (cond
      (contains? entity-clauses head)
      (let [[v cmap] args
            kinds (assoc-kind kinds v head)
            ;; a var in :layer position binds a layer var of the matching kind
            kinds (if (var? (:layer cmap))
                    (assoc-kind kinds (:layer cmap) (entity->layer-kind head))
                    kinds)]
        ;; :relation's :source/:target inline vars are spans
        (reduce (fn [kk rk]
                  (if-let [sv (get cmap rk)]
                    (assoc-kind kk sv :span)
                    kk))
                kinds [:source :target]))

      (= head :covers)     (-> kinds (assoc-kind (first args) :span)  (assoc-kind (second args) :token))
      (= head :precedes)   (-> kinds (assoc-kind (first args) :token) (assoc-kind (second args) :token))
      (= head :precedes*)  (-> kinds (assoc-kind (first args) :token) (assoc-kind (second args) :token))
      (= head :within)     (-> kinds (assoc-kind (first args) :token) (assoc-kind (second args) :token))
      (= head :first-in)   (-> kinds (assoc-kind (first args) :token) (assoc-kind (second args) :token))
      (= head :source)     (-> kinds (assoc-kind (first args) :relation) (assoc-kind (second args) :span))
      (= head :target)     (-> kinds (assoc-kind (first args) :relation) (assoc-kind (second args) :span))
      (= head :vocab-link) (-> kinds (assoc-kind (first args) :token) (assoc-kind (second args) :vocab))
      ;; a layer-constraint clause binds its var to the head's layer kind
      (contains? layer-clauses head) (assoc-kind kinds (first args) head)
      ;; :not contributes its inner clauses' kinds (so inner-only vars get a kind
      ;; for compilation, and an inner use conflicting with an outer use errors)
      (= head :not)        (reduce clause-kinds kinds args)
      :else kinds)))

(defn clause-vars
  "The vars a single positive (entity/relationship) clause mentions — its bound
  var(s), plus inline :source/:target and a :layer variable. (Not :not, which is
  filtered upstream.)"
  [clause]
  (let [[head & args] clause]
    (cond
      (contains? entity-clauses head)
      (let [[v cmap] args]
        (into (if (var? v) [v] [])
              (keep #(let [x (get cmap %)] (when (var? x) x)) [:source :target :layer])))
      (contains? rel-clauses head) (filterv var? args)
      (contains? layer-clauses head) (if (var? (first args)) [(first args)] [])
      :else [])))

(defn positive-binding-vars
  "The set of vars bound by the POSITIVE part of a :where — i.e. every var that
  appears in a non-:not clause. A var appearing ONLY inside a :not is existential
  to that negation and is NOT positively bound (so it may not be a :find var)."
  [where]
  (set (mapcat clause-vars (remove #(= :not (first %)) where))))

(defn infer-kinds
  "Return a map of {var -> kind} (kind ∈ #{:span :token :relation}) for every var
  in the query, erroring on a var used inconsistently across clauses. Shared by
  `validate` and the compiler."
  [ast]
  (reduce clause-kinds {} (:where ast)))

;; ---------------------------------------------------------------------------
;; Validate
;; ---------------------------------------------------------------------------

(defn- validate-shape!
  [ast]
  (when-not (and (vector? (:find ast)) (seq (:find ast)))
    (err! :validate ":find must be a non-empty list of vars"))
  (when-not (every? var? (:find ast))
    (err! :validate (str ":find may only contain vars, got: " (pr-str (remove var? (:find ast))))))
  (when-not (apply distinct? (:find ast))
    (err! :validate (str ":find has duplicate variables: "
                         (pr-str (->> (:find ast) frequencies (keep (fn [[v n]] (when (> n 1) v))) vec)))))
  (when-not (vector? (:where ast))
    (err! :validate ":where must be a list of clauses"))
  (when (empty? (:where ast))
    (err! :validate ":where must contain at least one clause"))
  (when (contains? ast :as-of)
    (err! :validate "as-of (time-travel) queries are not supported in v0"))
  (when-let [l (:limit ast)]
    (when-not (and (integer? l) (pos? l))
      (err! :validate (str ":limit must be a positive integer, got: " (pr-str l)))))
  (when-let [r (:return ast)]
    (when-not (#{:ids :entities :count} r)
      (err! :validate (str ":return " (pr-str r) " is not supported (one of :ids, :entities, :count)"))))
  (when (contains? ast :strict-layers)
    (when-not (boolean? (:strict-layers ast))
      (err! :validate (str ":strict-layers must be true or false, got: " (pr-str (:strict-layers ast))))))
  (when-let [ob (:order-by ast)]
    (let [find-set (set (:find ast))]
      (doseq [[v attr dir] ob]
        (when-not (var? v)
          (err! :validate (str ":order-by var must be a var, got: " (pr-str v))))
        (when-not (find-set v)
          (err! :validate (str ":order-by may only reference :find vars; " v " is not selected")))
        (when-not (#{:asc :desc} dir)
          (err! :validate (str ":order-by direction must be asc or desc, got: " (pr-str dir)))))))
  ast)

(defn- validate-regex-spec!
  "Validate a `{:regex \"...\" :flags \"i\"?}` constraint value. Compiles the
  pattern so a malformed regex is a 400 here, not a runtime error in the UDF."
  [head k spec]
  (when-not (regex-keys k)
    (err! :validate (str ":" (name head) " constraint :" (name k)
                         " does not support a regex (allowed on " (vec (sort regex-keys)) ")")))
  (let [{:keys [regex flags]} spec
        extra (remove #{:regex :flags} (keys spec))]
    (when (seq extra)
      (err! :validate (str "regex spec has unknown key(s) " (vec extra) " (allowed :regex, :flags)")))
    (when-not (string? regex)
      (err! :validate (str ":" (name k) " regex must be a string, got: " (pr-str regex))))
    (when (> (count regex) regex-max-len)
      (err! :validate (str ":" (name k) " regex is too long (max " regex-max-len " chars)")))
    (when (and flags (or (not (string? flags)) (not (re-matches #"i*" flags))))
      (err! :validate (str ":" (name k) " regex flags " (pr-str flags) " unsupported (only \"i\")")))
    (try (re-pattern regex)
         (catch java.util.regex.PatternSyntaxException e
           (err! :validate (str ":" (name k) " has an invalid regex: " (.getMessage e)))))))

(defn- validate-clause!
  [clause]
  (let [[head & args] clause]
    (cond
      (contains? deferred-clauses head)
      (err! :validate (str "Clause :" (name head) " is recognized but not yet supported in v0"))

      (contains? entity-clauses head)
      (let [[v cmap] args]
        (when-not (var? v)
          (err! :validate (str "Entity clause :" (name head) " needs a var as its first argument, got: "
                               (pr-str v))))
        (when (and (some? cmap) (not (map? cmap)))
          (err! :validate (str "Entity clause :" (name head) " constraints must be a map, got: " (pr-str cmap))))
        (when (> (count args) 2)
          (err! :validate (str "Entity clause :" (name head) " takes at most a var and a constraint map")))
        (let [allowed (entity-clauses head)
              unknown (remove allowed (keys (or cmap {})))]
          (when (seq unknown)
            (err! :validate (str "Unknown constraint key(s) " (vec unknown) " on :" (name head)
                                 " (allowed: " (vec (sort allowed)) ")"))))
        ;; value shapes: a vector value means "one of" -> IN (alternation, on the
        ;; literal-match keys only); a map value means a regex spec (regex-keys
        ;; only). A scalar is plain equality.
        (doseq [[k v] cmap]
          (cond
            (vector? v)
            (do (when-not (alternation-keys k)
                  (err! :validate (str ":" (name head) " constraint :" (name k)
                                       " does not support a list value (alternation is allowed on "
                                       (vec (sort alternation-keys)) ")")))
                (when (empty? v)
                  (err! :validate (str ":" (name head) " constraint :" (name k) " list must be non-empty"))))
            (map? v)
            (validate-regex-spec! head k v))))

      (contains? rel-clauses head)
      (let [arity (rel-clauses head)]
        (when-not (= (count args) arity)
          (err! :validate (str "Clause :" (name head) " takes " arity " vars, got " (count args))))
        (when-not (every? var? args)
          (err! :validate (str "Clause :" (name head) " arguments must all be vars, got: " (pr-str (vec args))))))

      (contains? layer-clauses head)
      (let [[v cmap] args]
        (when-not (var? v)
          (err! :validate (str "Layer clause :" (name head) " needs a layer var as its first argument, got: " (pr-str v))))
        (when (and (some? cmap) (not (map? cmap)))
          (err! :validate (str "Layer clause :" (name head) " constraints must be a map, got: " (pr-str cmap))))
        (let [allowed (layer-clauses head)
              unknown (remove allowed (keys (or cmap {})))]
          (when (seq unknown)
            (err! :validate (str "Unknown constraint key(s) " (vec unknown) " on :" (name head)
                                 " (allowed: " (vec (sort allowed)) ")")))))

      (= head :not)
      (do
        (when (empty? args)
          (err! :validate ":not needs at least one clause to negate"))
        ;; recurse: the negated body is entity/relationship clauses and nested
        ;; :not (a nested NOT EXISTS); any :or/:seq inside a :not were already
        ;; De-Morganed away by `expand`.
        (run! validate-clause! args))

      :else
      (err! :validate (str "Unknown clause head :" (name head))))))

(defn validate
  "Validate a canonical AST. Runs shape checks, per-clause checks, var-kind
  inference (conflict detection), and the safety check (every :find var is
  bound somewhere in :where). Returns the AST with `:return` defaulted to
  `:ids` and `::var-kinds` attached. Throws `:code 400` on any problem."
  [ast]
  (validate-shape! ast)
  (run! validate-clause! (:where ast))
  (let [kinds (infer-kinds ast)
        positive (positive-binding-vars (:where ast))
        find-unbound (remove positive (:find ast))]
    (when (seq find-unbound)
      (err! :validate (str "Var(s) " (vec find-unbound) " in :find are never positively bound "
                           "(a var that appears only inside :not is not bound)")
            {:vars (vec find-unbound)}))
    (doseq [[v attr _] (:order-by ast)]
      (let [k (get kinds v)
            allowed (order-attrs k)]
        (when-not (and allowed (allowed attr))
          (err! :validate (str ":order-by cannot sort a " (name (or k :unknown)) " var (" v ") by "
                               attr "; allowed: " (vec (sort (or allowed #{}))))))))
    (-> ast
        (assoc :return (or (:return ast) :ids))
        (assoc ::var-kinds kinds))))

(defn parse+validate
  "Convenience: parse a raw body then validate. Returns the checked canonical AST.
  Does NOT desugar `:seq` — use `expand` for the full pipeline."
  [raw]
  (validate (parse raw)))

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
(defn- seq-atom? [elem] (contains? entity-clauses (first elem)))
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
    (let [allowed (entity-clauses head)
          unknown (remove allowed (keys (or cmap {})))]
      (when (seq unknown)
        (err! :validate (str "Unknown constraint key(s) " (vec unknown) " in seq :" (clojure.core/name head) " element"))))))

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

(defn- expand-where
  "Expand a :where (possibly with :seq/:or) into one or more conjunctive branch
  :where vectors (UNIONed downstream). No disjunction -> a single branch equal to
  the input."
  [where]
  (expand-clauses (vec where) (atom 0)))

(defn- check-branch-consistency!
  "Cross-branch checks for a query that expanded to >1 branch (via :or/:seq):
  every :find var must be bound in EVERY branch (so the UNION columns are always
  populated) and have the SAME kind across branches (so a result column is one
  entity type and :entities hydrates each row with the right reader)."
  [branch-wheres find-vars]
  (let [branch-kinds (mapv (fn [w] (infer-kinds {:where w})) branch-wheres)]
    (doseq [v find-vars]
      (when-not (every? #(contains? % v) branch-kinds)
        (err! :validate (str "Find var " v " is not bound in every branch — each :or alternative must bind it")
              {:var v}))
      (let [ks (distinct (map #(get % v) branch-kinds))]
        (when (> (count ks) 1)
          (err! :validate (str "Find var " v " has inconsistent kinds across branches: " (vec ks)
                               " — every branch must bind it to the same entity kind")
                {:var v :kinds (vec ks)}))))))

(defn expand
  "Parse + desugar (`:seq` / `:or`) + validate. Returns a NON-EMPTY vector of
  validated branch ASTs sharing the same :find/:scope/:limit/:return; the executor
  UNIONs them. This is the entry point the query endpoint uses (handles the
  disjunctive sugar, unlike `parse+validate`)."
  [raw]
  (let [parsed (parse raw)
        base (dissoc parsed :where)
        branch-wheres (expand-where (vec (:where parsed)))]
    (when (> (count branch-wheres) 1)
      (check-branch-consistency! branch-wheres (:find parsed)))
    (mapv (fn [w] (validate (assoc base :where (vec w)))) branch-wheres)))
