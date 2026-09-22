(ns plaid.query.ast
  "The entry to the Plaid query language: an untrusted request body in, a
  checked canonical AST out.

  Owns the wire dialect — `parse` turns a JSON-ish map into the canonical EDN
  AST, resolving `:bindings` placeholders first so nothing downstream sees a
  placeholder. The three pipeline entry points live here:

    `parse`           wire -> canonical AST (shape only)
    `parse+validate`  the above, then `plaid.query.validate/validate`
    `expand`          parse, desugar `:seq`/`:or`/`:not`, validate each branch

  `expand` is what the query endpoint and the compiler call; it returns a
  non-empty vector of branch ASTs the executor UNIONs.

  The language's own vocabulary (clause tables, field paths, kind inference)
  is `plaid.query.clauses`; validation is `plaid.query.validate`; the
  desugaring is `plaid.query.desugar`. Nothing here knows about SQL or the
  database.

  Canonical AST shape:
    {:find   [?s1 ?s2]            ; non-empty vector of vars (symbols starting with ?)
     :where  [[:span ?s1 {:layer \"<layer-id>\" :value \"NOUN\"}] ...]
     :scope  {:project-ids [...]} ; optional; projects identified by id only
     :limit  100                  ; optional positive int
     :return :ids}                ; defaulted to :ids

  Vars are Clojure symbols beginning with `?` (e.g. `?s1`). JSON sends them as
  the strings \"?s1\"; `parse` converts.

  Every author-facing problem is thrown as `(ex-info msg {:code 400 ...})`,
  matching the `:code`->HTTP convention used throughout `plaid.rest-api.v1`."
  (:require [clojure.string :as str]
            [clojure.walk :as walk]
            [plaid.query.clauses :as clauses :refer [err!]]
            [plaid.query.desugar :as desugar]
            [plaid.query.validate :as validate]))

;; ---------------------------------------------------------------------------
;; The {"literal": v} escape
;; ---------------------------------------------------------------------------
;; On the JSON wire a string beginning with `?` is a variable, so a value that
;; really begins with `?` (an uncertain gloss like "?PL") can only be written
;; wrapped. Recognized in a :metadata constraint and in a predicate term, the two
;; places a bare `?`-string would otherwise be read as a variable. Keys arrive
;; from the wire as strings, so both spellings are accepted.

(defn- literal-key
  "The key a `{:literal v}` wrapper is written under, or nil if `x` is not one."
  [x]
  (when (map? x)
    (cond (contains? x :literal) :literal
          (contains? x "literal") "literal")))

(defn- unwrap-literal
  "The value inside a `{:literal v}` term. Rejects a companion key and a
  non-scalar payload, so the wrapper cannot smuggle a map or a list past the
  term checks."
  [x]
  (let [k (literal-key x)
        extra (remove #{k} (keys x))]
    (when (seq extra)
      (err! :parse (str "A {\"literal\": …} term takes no other key(s), got: " (vec extra))))
    (let [v (get x k)]
      (when-not (or (string? v) (number? v) (boolean? v))
        (err! :parse (str "A {\"literal\": …} term must wrap a string, number or boolean, got: "
                          (pr-str v))))
      v)))

(defn- ->term
  "Normalize a predicate/aggregate scalar term: a `{:literal v}` wrapper -> the
  wrapped value; a dotted field path -> field-ref; a `?name` -> var; anything
  else -> literal (passes through)."
  [x]
  (cond
    (literal-key x) (unwrap-literal x)
    (clauses/dotted-name? x) (clauses/->field-ref x)
    :else (clauses/->var x)))

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
  query variable — `:source`/`:target` (inline relation endpoints), `:layer` (a
  layer variable), and the layer structural slots (`:text-layer` etc.).
  `clauses/->var` only coerces strings that actually look like vars (`\"?x\"`),
  so a literal layer ref (`\"pos\"`) or a literal gloss (`\"?\"`) stays a string.
  Every other value (`:value` `:form` `:doc` `:begin` `:end`) is left untouched."
  [m]
  (when-not (map? m)
    (err! :parse (str "Clause constraint must be a map, got: " (pr-str m))))
  (reduce-kv (fn [acc k v]
               (let [k (->kw k)]
                 (assoc acc k (cond
                                (clauses/var-slots k) (clauses/->var v)
                                ;; :metadata is a map of arbitrary metadata KEYS (kept
                                ;; verbatim — case-sensitive strings) to value specs
                                ;; (each spec keyword-ized if it's a regex map).
                                ;; The REST layer keywordizes JSON object keys (same
                                ;; as :bindings — see `placeholder-name`), so restore
                                ;; a keyword key to its verbatim string here.
                                ;; `(str (symbol ..))` keeps a `/`-containing key
                                ;; intact where `name` would drop its "namespace".
                                ;; (a non-map :metadata is left as-is so validate-metadata!
                                ;; can reject it with a clean 400, rather than reduce-kv
                                ;; throwing an uncaught error here at parse time)
                                (= k :metadata)
                                (if (map? v)
                                  (reduce-kv (fn [a mk spec]
                                               (let [mk (if (keyword? mk) (str (symbol mk)) mk)]
                                                 (assoc a mk (if (map? spec)
                                                               (reduce-kv (fn [s ik iv] (assoc s (->kw ik) iv)) {} spec)
                                                               spec))))
                                             {} v)
                                  v)
                                ;; a map value is a special spec: a regex {:regex ..}
                                ;; or a value variable {:var "?v"}. Keyword-ize the
                                ;; keys and var-ize the :var payload. (A plain string
                                ;; value is ALWAYS a literal — no `?x` ambiguity.)
                                (map? v) (let [m2 (reduce-kv (fn [a ik iv] (assoc a (->kw ik) iv)) {} v)]
                                           (cond-> m2 (contains? m2 :var) (update :var clauses/->var)))
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
                  (clauses/->var (second more))
                  (err! :parse (str "Unexpected token in seq element after constraints: "
                                    (pr-str (first more))))))]
    (cond-> [head cmap] named (conj :as named))))

;; Bounds parse/expand/validate recursion so a deeply-nested clause body (e.g.
;; `[:not [:not [:not ...]]]`) can't blow the stack with a StackOverflowError —
;; which, being an `Error` not an `Exception`, would escape the endpoint's
;; ExceptionInfo/Exception handlers and surface as an uncaught 500. Capping at
;; parse time bounds the depth of every downstream walk too.
(def ^:private max-clause-depth 64)

(defn- normalize-seq-element
  ([elem] (normalize-seq-element elem 0))
  ([elem depth]
   (when (> depth max-clause-depth)
     (err! :parse (str "Seq element quantifiers nested too deeply (max " max-clause-depth ")")))
   (when-not (and (sequential? elem) (seq elem))
     (err! :parse (str "Each seq element must be a non-empty vector, got: " (pr-str elem))))
   (let [head (->kw (first elem))]
     (cond
       (#{:? :* :+} head) [head (normalize-seq-element (second elem) (inc depth))]
       (= :rep head)      (let [[_ n m inner] elem] [:rep n m (normalize-seq-element inner (inc depth))])
       :else              (normalize-seq-atom head (rest elem))))))

(declare normalize-clause)

(defn- normalize-or-clause
  "Normalize an [:or group ...] clause; each group is a list of clauses (its own
  conjunction). Clauses are normalized recursively, so groups may nest :or/:seq."
  [groups depth]
  (into [:or]
        (map (fn [g]
               (when-not (sequential? g)
                 (err! :parse (str "Each :or group must be a list of clauses, got: " (pr-str g))))
               (mapv #(normalize-clause % depth) g)))
        groups))

(defn- normalize-not-clause
  "Normalize a [:not clause ...] clause; the negated sub-pattern is the
  conjunction of the given clauses (normalized recursively)."
  [clauses depth]
  (into [:not] (map #(normalize-clause % depth) clauses)))

(defn- normalize-seq-clause
  "Normalize a [:seq {config} elem ...] clause."
  [args depth]
  (when-not (map? (first args))
    (err! :parse "A :seq clause needs a config map (with at least :layer) as its first argument"))
  (into [:seq (normalize-constraints (first args))]
        (map #(normalize-seq-element % depth) (rest args))))

(defn- normalize-regex-rhs
  "Normalize a `:~` right-hand side: a bare string `\"^N\"` is sugar for `{:regex \"^N\"}`;
  a map has its keys keyword-ized (so `{\"regex\" .. \"flags\" ..}` matches the spec
  validator). Anything else passes through for `validate` to 400."
  [rhs]
  (cond
    (string? rhs) {:regex rhs}
    (map? rhs)    (reduce-kv (fn [a k v] (assoc a (->kw k) v)) {} rhs)
    :else         rhs))

(defn- normalize-clause
  ([clause] (normalize-clause clause 0))
  ([clause depth]
   (when (> depth max-clause-depth)
     (err! :parse (str "Query clauses nested too deeply (max " max-clause-depth ")")))
   (when-not (and (sequential? clause) (seq clause))
     (err! :parse (str "Each :where clause must be a non-empty vector, got: " (pr-str clause))))
   (let [head (->kw (first clause))
         d (inc depth)]
     (cond
       (= head :seq) (normalize-seq-clause (rest clause) d)
       (= head :or)  (normalize-or-clause (rest clause) d)
       (= head :not) (normalize-not-clause (rest clause) d)
       ;; predicate: terms are vars or literals (numbers/strings pass through)
       ;; predicate terms may be field paths (?t.begin), vars, or literals
       (clauses/pred-ops head) (into [head] (map ->term) (rest clause))
       ;; attribute predicates: ->term only the LHS — the RHS is a regex spec
       ;; (`~`) or a literal members list (`in`) and must NOT be var-ized. Arity is
       ;; checked HERE (destructuring would otherwise silently drop extra args, unlike
       ;; the comparison preds above which keep every term for validate to count).
       (= head clauses/op-match) (let [args (rest clause)]
                                   (when-not (= (count args) 2)
                                     (err! :parse (str "~ takes a field path and a regex, got " (count args) " term(s)")))
                                   [clauses/op-match (->term (first args)) (normalize-regex-rhs (second args))])
       (= head :in)      (let [args (rest clause)]
                           (when-not (= (count args) 2)
                             (err! :parse (str "in takes a term and a list, got " (count args) " term(s)")))
                           [:in (->term (first args)) (second args)])
       :else (into [head]
                   (map (fn [a] (if (map? a) (normalize-constraints a) (clauses/->var a))))
                   (rest clause))))))

(defn- normalize-order-spec
  "Canonicalize one :order-by entry to `[field-ref :dir]` (dir defaults :asc).
  Accepts a dotted field `[\"?t.begin\" dir?]` or the legacy `[\"?t\" \"begin\" dir?]`."
  [spec]
  (when-not (sequential? spec)
    (err! :parse (str "Each :order-by entry must be a list, got: " (pr-str spec))))
  (if (clauses/dotted-name? (first spec))
    (do (when-not (<= 1 (count spec) 2)
          (err! :parse (str ":order-by entry " (pr-str spec) " takes [field] or [field dir]")))
        (let [[f dir] spec] [(clauses/->field-ref f) (if (nil? dir) :asc (->kw dir))]))
    (do (when-not (<= 2 (count spec) 3)
          (err! :parse (str ":order-by entry " (pr-str spec) " takes [var attr] or [var attr dir]")))
        (let [[v attr dir] spec]
          [{clauses/field-key {:var (clauses/->var v) :path [(name (->kw attr))]}} (if (nil? dir) :asc (->kw dir))]))))

(defn- normalize-agg-entry
  "Canonicalize one aggregate to `[:op]` (count) or `[:op src]` (src = a value var
  or a field path)."
  [entry]
  (when-not (and (sequential? entry) (<= 1 (count entry) 2))
    (err! :parse (str "Each aggregate must be [op] or [op var], got: " (pr-str entry))))
  (let [[op src] entry]
    (cond-> [(->kw op)] (some? src) (conj (->term src)))))

(defn- normalize-return
  "`:return` is either a keyword (:ids/:entities/:count) or an aggregate spec map
  `{:group [vars] :aggregates [[op src?]...]}`."
  [v]
  (if (map? v)
    (let [m (reduce-kv (fn [a k vv] (assoc a (->kw k) vv)) {} v)
          g (:group m []) a (:aggregates m [])]
      ;; guard non-list group/aggregates at parse so mapv doesn't throw an uncaught
      ;; error (validate-aggregate-spec! gives the richer message once shaped)
      (when-not (sequential? g)
        (err! :parse (str ":return :group must be a list, got: " (pr-str g))))
      (when-not (sequential? a)
        (err! :parse (str ":return :aggregates must be a list, got: " (pr-str a))))
      {:group (mapv ->term g)
       :aggregates (mapv normalize-agg-entry a)})
    (->kw v)))

;; ---------------------------------------------------------------------------
;; Bindings (query parameters): a `?name` placeholder spliced to a literal
;; ---------------------------------------------------------------------------
;; A top-level `:bindings` map `{"?txtl" <literal>}` lets a placeholder that
;; LOOKS like a free var be pinned to a concrete value. Substitution happens
;; here, at the wire-parse boundary, BEFORE clause normalization — so the
;; placeholder is replaced before anything could interpret it as a var, and it
;; behaves exactly as if the literal were typed inline anywhere it appears
;; (layer ref, value, doc, scope id, …). Bindings are literals, so a bound layer
;; id flows through scope/resolution like an inline id — no new ACL surface.

(defn- placeholder-name
  "The canonical `?name` (string) of a token usable as a binding placeholder — a
  `?`-prefixed string, symbol, or keyword — else nil. (Keywords arise because the
  REST layer keywordizes JSON object keys, so a `bindings` key reaches us as
  `:?lyr`; placeholders used as clause *values* stay strings.)"
  [x]
  (cond
    (and (string? x) (str/starts-with? x "?")) x
    (and (or (symbol? x) (keyword? x)) (str/starts-with? (name x) "?")) (name x)
    :else nil))

(defn- valid-binding-value?
  "A binding value is a scalar literal or a non-empty list of scalar literals
  (a list drives `IN`/alternation in a value position). Maps/vars are rejected."
  [v]
  (or (clauses/scalar-literal? v)
      (and (sequential? v) (seq v) (every? clauses/scalar-literal? v))))

(defn- build-bindings
  "Validate the raw `:bindings` value and return `{\"?name\" -> literal}`."
  [raw-bindings]
  (when-not (map? raw-bindings)
    (err! :parse (str ":bindings must be a map of \"?name\" -> value, got: " (pr-str raw-bindings))))
  (reduce-kv
   (fn [acc k v]
     (let [pname (placeholder-name k)]
       (when-not pname
         (err! :parse (str ":bindings keys must be ?-prefixed placeholder names, got: " (pr-str k))))
       (when-not (valid-binding-value? v)
         (err! :parse (str ":bindings " pname " value must be a scalar or non-empty list of scalars, got: " (pr-str v))))
       (assoc acc pname v)))
   {} raw-bindings))

(defn- apply-bindings
  "Splice `subst` values into `x` wherever a placeholder token appears. Returns
  `[substituted used-name-set]`. Single pass — a spliced value is never
  re-scanned (no chaining), since postwalk visits each node once bottom-up."
  [x subst]
  (let [used (volatile! #{})
        f (fn [node]
            (if-let [pname (placeholder-name node)]
              (if (contains? subst pname)
                (do (vswap! used conj pname) (get subst pname))
                node)
              node))]
    [(walk/postwalk f x) @used]))

(defn parse
  "Normalize a raw request map (string- or keyword-keyed; JSON or EDN dialect)
  into the canonical EDN AST. Pure; does not validate semantics beyond the
  shape needed to normalize. Throws `:code 400` on gross malformation.

  A top-level `:bindings` map splices `?name` placeholders to literals first
  (see above); the rest of the pipeline only ever sees the substituted query."
  [raw]
  (when-not (map? raw)
    (err! :parse (str "Query must be a map/object, got: " (pr-str raw))))
  (let [m0 (reduce-kv (fn [acc k v] (assoc acc (->kw k) v)) {} raw)
        subst (when (contains? m0 :bindings) (build-bindings (:bindings m0)))
        [m used] (if subst (apply-bindings (dissoc m0 :bindings) subst) [m0 #{}])]
    ;; strict: every binding must be referenced (a typo'd/unused placeholder is
    ;; almost always a mistake). Misuse of a placeholder in a var-only slot needs
    ;; no special check — it becomes a literal there and trips the existing
    ;; "must be a var" validation downstream.
    (when subst
      (when-let [unused (seq (remove used (keys subst)))]
        (err! :parse (str "binding(s) " (vec unused) " not referenced in the query"))))
    (cond-> {}
      (contains? m :find)   (assoc :find (let [f (:find m)]
                                           (when-not (sequential? f)
                                             (err! :parse (str ":find must be a list of vars, got: " (pr-str f))))
                                           (mapv clauses/->var f)))
      (contains? m :where)  (assoc :where (let [w (:where m)]
                                            (when-not (sequential? w)
                                              (err! :parse (str ":where must be a list of clauses, got: " (pr-str w))))
                                            (mapv normalize-clause w)))
      (contains? m :scope)  (assoc :scope (let [s (:scope m)]
                                            (when-not (map? s)
                                              (err! :parse (str ":scope must be a map with :project-ids, got: " (pr-str s))))
                                            (let [sc (reduce-kv (fn [a k v] (assoc a (->kw k) v)) {} s)]
                                              ;; projects are identified by id only — scope-by-name is gone
                                              ;; (project names are non-unique across a multi-tenant instance)
                                              (when (contains? sc :projects)
                                                (err! :parse "scope by project name (:projects) is no longer supported — use :project-ids (projects are identified by id)"))
                                              ;; closed key set: an unknown key silently widening scope is a footgun
                                              (when-let [unknown (seq (remove #{:project-ids} (keys sc)))]
                                                (err! :parse (str "Unknown :scope key(s) " (vec unknown) " (allowed: [:project-ids])")))
                                              ;; project-ids must be a list if present (else effective-scope's empty?/seq throws a 500)
                                              (when (and (contains? sc :project-ids) (not (sequential? (:project-ids sc))))
                                                (err! :parse (str ":scope :project-ids must be a list, got: " (pr-str (:project-ids sc)))))
                                              ;; and a non-empty one: `effective-scope` reads an empty list as
                                              ;; "no scope given" and widens to every readable project, which is
                                              ;; the opposite of what an author narrowing scope asked for. Every
                                              ;; other list in the language must be non-empty for the same reason.
                                              (when (and (contains? sc :project-ids) (empty? (:project-ids sc)))
                                                (err! :parse ":scope :project-ids must be a non-empty list of project ids (omit :scope to search every project you can read)"))
                                              sc)))
      (contains? m :limit)  (assoc :limit (:limit m))
      (contains? m :order-by) (assoc :order-by (let [ob (:order-by m)]
                                                 (when-not (sequential? ob)
                                                   (err! :parse (str ":order-by must be a list of [var attr dir] entries, got: " (pr-str ob))))
                                                 (mapv normalize-order-spec ob)))
      (contains? m :return) (assoc :return (normalize-return (:return m)))
      (contains? m :as-of)  (assoc :as-of (:as-of m)))))     ; carried so validate can reject it

;; ---------------------------------------------------------------------------
;; Pipeline entry points
;; ---------------------------------------------------------------------------

(defn parse+validate
  "Convenience: parse a raw body then validate. Returns the checked canonical AST.
  Does NOT desugar `:seq` — use `expand` for the full pipeline."
  [raw]
  (validate/validate (parse raw)))

(defn expand
  "Parse + desugar (`:seq` / `:or`) + validate. Returns a NON-EMPTY vector of
  validated branch ASTs sharing the same :find/:scope/:limit/:return; the executor
  UNIONs them. This is the entry point the query endpoint uses (handles the
  disjunctive sugar, unlike `parse+validate`)."
  [raw]
  (let [parsed (parse raw)
        base (dissoc parsed :where)
        agg? (clauses/aggregate? parsed)
        ;; the vars projected through the UNION: :find normally, or the aggregate
        ;; spec's group + source vars in aggregate mode. Every branch must bind them.
        projected (if agg? (clauses/aggregate-vars (:return parsed)) (:find parsed))
        branch-wheres (desugar/expand-where (vec (:where parsed)))]
    (when (> (count branch-wheres) 1)
      (desugar/check-branch-consistency! branch-wheres projected))
    ;; Under aggregation every branch projects the SAME entity columns, and by
    ;; ruling those are the ones EVERY branch binds: what an alternative binds
    ;; alone does not make a match distinct, so a row satisfying two
    ;; alternatives is counted once. The set travels with each branch.
    ;; `some?`, not `seq`: an empty set is a real answer (alternatives sharing
    ;; no entity var), and means project no entity columns at all.
    (let [align (when (and agg? (> (count branch-wheres) 1))
                  (desugar/aggregate-branch-entities branch-wheres))]
      (mapv (fn [w]
              (cond-> (validate/validate (assoc base :where (vec w)))
                (some? align) (assoc ::align-entities align)))
            branch-wheres))))
