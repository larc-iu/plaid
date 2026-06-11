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
     :where  [[:span ?s1 {:layer \"<layer-id>\" :value \"NOUN\"}] ...]
     :scope  {:project-ids [...]} ; optional; projects identified by id only
     :limit  100                  ; optional positive int
     :return :ids}                ; defaulted to :ids

  Vars are Clojure symbols beginning with `?` (e.g. `?s1`). JSON sends them as the
  strings \"?s1\"; `parse` converts.

  Covers the full clause set: entity clauses (span/token/relation/vocab/document/
  text) with literal/list/regex/value-variable constraints + :metadata; the
  relationship clauses (covers, precedes(*), within, first-in, overlaps, contains,
  coextensive, source, target, vocab-link, related*); predicate clauses; :or/:seq/
  :not; layer variables; :order-by; and :return ids/entities/count/aggregate. The
  `deferred-clauses` mechanism (now empty) still rejects any future-reserved head
  with a clear message; `:as-of` is rejected as the bitemporal seam."
  (:refer-clojure :exclude [var?])
  (:require [clojure.string :as str]
            [clojure.walk :as walk]))

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
  {:span     #{:layer :value :doc :metadata}
   ;; :token :value is the SURFACE substring (text body[begin,end]) — computed, the
   ;; domain's :token/value — not an annotation like span/relation :value.
   :token    #{:layer :value :doc :begin :end :metadata}
   :relation #{:layer :value :doc :source :target :metadata}
   :vocab    #{:layer :form :metadata}
   :document #{:name :id :metadata}
   :text     #{:body :doc :metadata}})

;; Constraint keys whose value may be a vector = "one of" (compiles to IN). The
;; literal-match keys only — NOT :layer (multi-layer is unique-or-400 / future
;; layer vars) or :source/:target (vars).
(def ^:private alternation-keys #{:value :form :doc :begin :end :name :body :id})

;; Constraint keys whose value may be a regex spec `{:regex "..." :flags "i"?}`
;; (compiles to a REGEXP match). Text-valued keys only.
(def ^:private regex-keys #{:value :form :name :body})
(def ^:private regex-max-len 512)

;; Constraint keys whose value may be a SCALAR VARIABLE: `{:value "?v"}` binds
;; `?v` to that column instead of filtering, so the same `?v` in two clauses is a
;; column-equality join (e.g. two spans with the *same* value). Scalar vars are a
;; distinct kind (`:scalar`) — not an entity, not selectable in :find (v0).
(def ^:private scalar-keys #{:value :form :begin :end :doc})

;; Predicate clauses compare two already-bound terms: `[:= ?a ?b]`, `[:!= ?s1 ?s2]`,
;; `[:< ?n 5]`. A term is a var or a literal. Entity-var comparisons are := / :!=
;; only (ids are unordered); scalar/literal terms allow the ordering ops too.
(def ^:private pred-ops #{:= :!= :< :> :<= :>=})
(def ^:private order-pred-ops #{:< :> :<= :>=})

;; "Attribute predicate" clauses — the Datalog-style decomposition of constraint-map
;; entries: `["~" ?s.value {:regex ..}]` (regex, the standalone form of the `:value
;; {:regex}` constraint) and `["in" ?s.value [..]]` (membership, the standalone form
;; of a list/alternation constraint). Compiled on the predicate path (no desugar).
;; The regex head is the keyword named "~"; `:~` is not a readable literal (`~` is the
;; unquote reader macro), so it is constructed and referenced through `op-match`. Using
;; the literal "~" (not a word like "match") also means no other wire token aliases it.
;; Public so the compiler shares this one definition (the dispatch matches on it).
(def op-match (keyword "~"))
(def ^:private attr-pred-ops #{op-match :in})

;; Aggregate ops for `:return {:group [...] :aggregates [[op src?]...]}`. `:count`
;; counts matches (no source); the rest aggregate a scalar variable. SUM/AVG
;; assume the scalar is numeric; MIN/MAX work on anything comparable.
(def ^:private agg-ops #{:count :sum :avg :min :max})
(def ^:private agg-needs-source #{:sum :avg :min :max})

;; Layer-constraint clauses: [:span-layer ?sl {constraint-map}]. The head IS the
;; layer kind; binds/constrains a LAYER variable. Value = allowed constraint keys.
;; Besides its own attribute (:name) a layer clause may name its immutable
;; PARENT layer through a structural slot (see `layer-slot->kind`). `:text-layer` is
;; a queryable kind only so a token layer's text-layer parent can be bound/constrained.
(def ^:private layer-clauses
  {:text-layer     #{:name}
   :token-layer    #{:name :text-layer :parent-token-layer}
   :span-layer     #{:name :token-layer}
   :relation-layer #{:name :span-layer}
   :vocab-layer    #{:name}})

;; Structural slots: a layer clause may reference its PARENT layer (the immutable FK
;; in the data model) by a slot named after the domain attribute. The slot value is a
;; layer variable (binds + joins the parent node) or a scalar layer reference
;; (resolved to one layer) — exactly like an entity's :layer slot. Keyed by
;; [clause-head slot] -> the parent layer kind the slot references.
(def ^:private layer-slot->kind
  {[:token-layer :text-layer]         :text-layer
   [:token-layer :parent-token-layer] :token-layer
   [:span-layer :token-layer]         :token-layer
   [:relation-layer :span-layer]      :span-layer})

(defn layer-slots-for
  "The `[slot parent-kind]` structural-slot entries available on a layer clause head
  (empty for entity heads and for layer kinds with no parent — text-layer/vocab-layer).
  Public so resolve/compile share this single source of truth."
  [head]
  (keep (fn [[[h slot] tgt]] (when (= h head) [slot tgt])) layer-slot->kind))

;; Constraint keys whose value may be a query variable (so it is var-ized at parse):
;; the entity :layer / relation-endpoint slots plus every layer structural slot.
(def ^:private var-slots
  (into #{:source :target :layer} (map second) (keys layer-slot->kind)))

;; Relationship clauses and their arity (number of var args after the head).
(def ^:private rel-clauses
  {:covers     2     ; [:covers ?span ?token]
   :precedes   2     ; [:precedes ?t1 ?t2]      immediate
   :precedes*  2     ; [:precedes* ?t1 ?t2]     transitive
   :source     2     ; [:source ?rel ?span]
   :target     2     ; [:target ?rel ?span]
   :within     2     ; [:within ?child ?parent] offset containment
   :first-in   2     ; [:first-in ?token ?container]
   :overlaps    2    ; [:overlaps ?a ?b]     spans share a covered token
   :contains    2    ; [:contains ?a ?b]     span ?a covers every token ?b does
   :coextensive 2    ; [:coextensive ?a ?b]  spans cover the same tokens
   :vocab-link 2})   ; [:vocab-link ?token ?vocab]

;; Clause heads accepted by the grammar but not implemented until a later
;; milestone. Rejected by validate with a "not yet supported" message rather
;; than an "unknown clause" one, so the surface stays forward-compatible.
;; (Empty now that :seq landed in M3 — the mechanism is retained for the next
;; deferral.)
(def ^:private deferred-clauses
  #{})

;; Scalar fields of each entity kind addressable via a dot-path (`?t.begin`),
;; order-by, or an aggregate. Backend-agnostic domain set; the compiler maps each
;; to a column. `:metadata` (open keys) is handled separately. Document/text are
;; included so they can be compared/ordered too. `:layer`/`:source`/`:target` are
;; opaque FK references (see `ref-attrs`): the dot-path form of the `:layer` /
;; `:source` / `:target` constraint slots.
(def ^:private entity-field-attrs
  {:span     #{:value :doc :id :layer}
   :token    #{:value :begin :end :precedence :doc :id :layer}
   :relation #{:value :doc :id :layer :source :target}
   :vocab    #{:form :id :layer}
   :document #{:name :id}
   :text     #{:body :doc :id}})

;; Reference fields: a dot-path to a FK id column (a layer or a relation endpoint).
;; They behave like opaque ids — only `=` / `!=` / `in` against a variable or an
;; id literal (no ordering, no name resolution — see the G4 check in `validate`).
(def ^:private ref-attrs #{:layer :source :target})

;; Layer variables expose name/id as scalar fields, plus open `config` keys.
(def ^:private layer-field-attrs #{:name :id})

;; Fields with no meaningful order (opaque ids): ordering predicate ops
;; (< > <= >=) are rejected on these, though `=`/`!=` and order-by are fine.
(def ^:private unordered-field-attrs #{:id :doc})

;; ---------------------------------------------------------------------------
;; Errors
;; ---------------------------------------------------------------------------

(defn- err!
  ([stage msg] (err! stage msg {}))
  ([stage msg data]
   (throw (ex-info msg (merge {:code 400 :query-error/stage stage} data)))))

(defn- uuid-like?
  "True if `s` looks like a UUID. Used to keep `?s.layer`/`?r.source`/`?r.target`
  reference comparisons to a variable or an id — a bare name literal is a loud 400,
  not a silent compare-to-string. (Local regex so ast.clj stays backend-agnostic.)"
  [s]
  (boolean (and (string? s)
                (re-matches #"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" s))))

;; ---------------------------------------------------------------------------
;; Field references — dotted paths: ?t.begin / ?s.metadata.k… / ?sl.config.k…
;; ---------------------------------------------------------------------------
;; A field reference is a `?var` followed by a dotted path. It is a scalar TERM
;; (usable in predicates / order-by / aggregates), never a bindable variable. The
;; QL-vocabulary segment (a core attr, or the `metadata`/`config` boundary word)
;; is CANONICALIZED so it is idiom-agnostic (camel/snake/kebab all match); keys
;; AFTER `metadata`/`config` are kept verbatim (case-sensitive user keys). Dots
;; are the separator, so metadata/config keys containing a literal `.` are not
;; reachable this way (use the `metadata` constraint map for those).

(def ^:private field-key ::field)
(def ^:private layer-kinds (set (keys layer-clauses)))
(defn- layer-kind? [k] (contains? layer-kinds k))

(defn field-ref? [x] (and (map? x) (contains? x field-key)))
(defn field-var  [fr] (:var  (get fr field-key)))
(defn field-path [fr] (:path (get fr field-key)))
(defn field->str [fr] (str (field-var fr) (apply str (map #(str "." %) (field-path fr)))))

(defn- canon-seg [s] (-> s str/lower-case (str/replace #"[-_]" "")))

;; canonical-segment -> core attr keyword (the QL-vocabulary head segment).
(def ^:private field-attr-by-canon
  (into {} (map (fn [a] [(canon-seg (name a)) a]))
        [:value :doc :id :begin :end :precedence :form :name :body
         :layer :source :target]))

(defn- dotted-name? [x]
  (let [n (cond (symbol? x) (name x) (string? x) x :else nil)]
    (boolean (and n (str/starts-with? n "?") (str/includes? n ".")))))

(defn- ->field-ref [x]
  (let [n (if (symbol? x) (name x) x)
        parts (str/split n #"\.")]
    (when (some str/blank? parts)
      (err! :parse (str "Malformed field path " (pr-str x) " (empty path segment)")))
    {field-key {:var (symbol (first parts)) :path (vec (rest parts))}}))

(declare ->var)
(defn- ->term
  "Normalize a predicate/aggregate scalar term: a dotted field path -> field-ref;
  a `?name` -> var; anything else -> literal (passes through)."
  [x]
  (if (dotted-name? x) (->field-ref x) (->var x)))

(defn field-resolve
  "Interpret a field-ref's `path` against the head var's `kind`. Returns one of
  `{:type :core :attr kw}` / `{:type :layer-attr :attr kw}` /
  `{:type :metadata :key str :subpath [str]}` / `{:type :config :subpath [str]}`,
  or `{:error msg}` for an invalid path. Shared by validate (errors -> 400) and
  the compiler (builds SQL)."
  [kind path]
  (if (empty? path)
    {:error "needs at least one attribute"}
    (let [layer? (layer-kind? kind)
          head (canon-seg (first path))]
      (cond
        (= head "metadata")
        ;; metadata is entity-only (a scalar var or a layer var has none) and needs a key
        (cond (not (contains? entity-field-attrs kind)) {:error "metadata is only available on entity variables"}
              (< (count path) 2) {:error "metadata needs a key (e.g. .metadata.author)"}
              :else {:type :metadata :key (second path) :subpath (vec (drop 2 path))})
        (= head "config")
        ;; config is layer-only and needs a key (symmetric with metadata)
        (cond (not layer?) {:error "config is only available on layer variables"}
              (< (count path) 2) {:error "config needs a key (e.g. .config.editor.color)"}
              :else {:type :config :subpath (vec (rest path))})
        :else
        (let [attr (field-attr-by-canon head)
              allowed (if layer? layer-field-attrs (get entity-field-attrs kind))]
          (cond
            (or (nil? attr) (not (contains? allowed attr)))
            {:error (str "unknown field " (pr-str (first path)) " (allowed: " (vec (sort (or allowed #{}))) ")")}
            (> (count path) 1) {:error (str "field " (pr-str (first path)) " is a scalar and takes no sub-path")}
            ;; a FK reference (entity-only; layer vars never reach here — :layer/
            ;; :source/:target aren't in layer-field-attrs, so the unknown-field
            ;; error above fires first)
            (ref-attrs attr) {:type :ref :attr attr}
            layer? {:type :layer-attr :attr attr}
            :else {:type :core :attr attr}))))))

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
  layer variable), and the layer structural slots (`:text-layer` etc.). `->var`
  only coerces strings that actually look like vars
  (`\"?x\"`), so a literal layer ref (`\"pos\"`) or a literal gloss (`\"?\"`)
  stays a string. Every other value (`:value` `:form` `:doc` `:begin` `:end`) is
  left untouched."
  [m]
  (when-not (map? m)
    (err! :parse (str "Clause constraint must be a map, got: " (pr-str m))))
  (reduce-kv (fn [acc k v]
               (let [k (->kw k)]
                 (assoc acc k (cond
                                (var-slots k) (->var v)
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
                                           (cond-> m2 (contains? m2 :var) (update :var ->var)))
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
       (pred-ops head) (into [head] (map ->term) (rest clause))
       ;; attribute predicates: ->term only the LHS — the RHS is a regex spec
       ;; (`~`) or a literal members list (`in`) and must NOT be var-ized. Arity is
       ;; checked HERE (destructuring would otherwise silently drop extra args, unlike
       ;; the comparison preds above which keep every term for validate to count).
       (= head op-match) (let [args (rest clause)]
                           (when-not (= (count args) 2)
                             (err! :parse (str "~ takes a field path and a regex, got " (count args) " term(s)")))
                           [op-match (->term (first args)) (normalize-regex-rhs (second args))])
       (= head :in)      (let [args (rest clause)]
                           (when-not (= (count args) 2)
                             (err! :parse (str "in takes a term and a list, got " (count args) " term(s)")))
                           [:in (->term (first args)) (second args)])
       :else (into [head]
                   (map (fn [a] (if (map? a) (normalize-constraints a) (->var a))))
                   (rest clause))))))

(defn- normalize-order-spec
  "Canonicalize one :order-by entry to `[field-ref :dir]` (dir defaults :asc).
  Accepts a dotted field `[\"?t.begin\" dir?]` or the legacy `[\"?t\" \"begin\" dir?]`."
  [spec]
  (when-not (sequential? spec)
    (err! :parse (str "Each :order-by entry must be a list, got: " (pr-str spec))))
  (if (dotted-name? (first spec))
    (do (when-not (<= 1 (count spec) 2)
          (err! :parse (str ":order-by entry " (pr-str spec) " takes [field] or [field dir]")))
        (let [[f dir] spec] [(->field-ref f) (if (nil? dir) :asc (->kw dir))]))
    (do (when-not (<= 2 (count spec) 3)
          (err! :parse (str ":order-by entry " (pr-str spec) " takes [var attr] or [var attr dir]")))
        (let [[v attr dir] spec]
          [{field-key {:var (->var v) :path [(name (->kw attr))]}} (if (nil? dir) :asc (->kw dir))]))))

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

(defn- scalar-literal? [x]
  (or (string? x) (number? x) (boolean? x)))

(defn- valid-binding-value?
  "A binding value is a scalar literal or a non-empty list of scalar literals
  (a list drives `IN`/alternation in a value position). Maps/vars are rejected."
  [v]
  (or (scalar-literal? v)
      (and (sequential? v) (seq v) (every? scalar-literal? v))))

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
                                           (mapv ->var f)))
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
                                              sc)))
      (contains? m :limit)  (assoc :limit (:limit m))
      (contains? m :order-by) (assoc :order-by (let [ob (:order-by m)]
                                                 (when-not (sequential? ob)
                                                   (err! :parse (str ":order-by must be a list of [var attr dir] entries, got: " (pr-str ob))))
                                                 (mapv normalize-order-spec ob)))
      (contains? m :return) (assoc :return (normalize-return (:return m)))
      (contains? m :as-of)  (assoc :as-of (:as-of m)))))     ; carried so validate can reject it

;; ---------------------------------------------------------------------------
;; Kind inference (backend-agnostic; domain concept, not SQL)
;; ---------------------------------------------------------------------------

(defn- assoc-kind
  "Record that `v` is of kind `k`, erroring on a conflicting prior kind."
  [kinds v k]
  (when-not (var? v)
    (err! :validate (str "Expected a var where one is required, got: " (pr-str v))))
  ;; a dotted name is a field path, not a bindable variable — reject it in every
  ;; var-binding position (entity/rel/layer clause slots all flow through here).
  (when (str/includes? (name v) ".")
    (err! :validate (str "Field path " v " cannot be used where a variable is bound; "
                         "dotted paths are only valid in predicates, order-by, and aggregates")))
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
                    kinds)
            ;; :relation's :source/:target inline vars are spans
            kinds (reduce (fn [kk rk]
                            (if-let [sv (get cmap rk)]
                              (assoc-kind kk sv :span)
                              kk))
                          kinds [:source :target])]
        ;; a {:var ?v} in a scalar-key value (:value/:form/:begin/:end/:doc) is a scalar var
        (reduce (fn [kk sk]
                  (let [x (get cmap sk)]
                    (if (and (map? x) (var? (:var x))) (assoc-kind kk (:var x) :scalar) kk)))
                kinds scalar-keys))

      (= head :covers)     (-> kinds (assoc-kind (first args) :span)  (assoc-kind (second args) :token))
      (= head :precedes)   (-> kinds (assoc-kind (first args) :token) (assoc-kind (second args) :token))
      (= head :precedes*)  (-> kinds (assoc-kind (first args) :token) (assoc-kind (second args) :token))
      (= head :within)     (-> kinds (assoc-kind (first args) :token) (assoc-kind (second args) :token))
      (= head :first-in)   (-> kinds (assoc-kind (first args) :token) (assoc-kind (second args) :token))
      (= head :overlaps)    (-> kinds (assoc-kind (first args) :span) (assoc-kind (second args) :span))
      (= head :contains)    (-> kinds (assoc-kind (first args) :span) (assoc-kind (second args) :span))
      (= head :coextensive) (-> kinds (assoc-kind (first args) :span) (assoc-kind (second args) :span))
      (= head :related*)    (-> kinds (assoc-kind (first args) :span) (assoc-kind (second args) :span))
      (= head :source)     (-> kinds (assoc-kind (first args) :relation) (assoc-kind (second args) :span))
      (= head :target)     (-> kinds (assoc-kind (first args) :relation) (assoc-kind (second args) :span))
      (= head :vocab-link) (-> kinds (assoc-kind (first args) :token) (assoc-kind (second args) :vocab))
      ;; a layer-constraint clause binds its var to the head's layer kind, and each
      ;; structural-slot var to its parent layer kind (assoc-kind detects conflicts
      ;; and rejects a dotted name in the slot)
      (contains? layer-clauses head)
      (let [[v cmap] args]
        (reduce (fn [kk [slot tgt]]
                  (let [x (get cmap slot)]
                    (if (var? x) (assoc-kind kk x tgt) kk)))
                (assoc-kind kinds v head)
                (layer-slots-for head)))
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
        (-> (if (var? v) [v] [])
            (into (keep #(let [x (get cmap %)] (when (var? x) x)) [:source :target :layer]))
            (into (keep #(let [x (get cmap %)] (when (and (map? x) (var? (:var x))) (:var x))) scalar-keys))))
      (contains? rel-clauses head) (filterv var? args)
      (= head :related*) (filterv var? args)   ; two span vars (the trailing map filters out)
      (contains? layer-clauses head)
      (let [[v cmap] args]
        (-> (if (var? v) [v] [])
            (into (keep (fn [[slot _]] (let [x (get cmap slot)] (when (var? x) x)))
                        (layer-slots-for head)))))
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

(defn aggregate?
  "True if `:return` is an aggregate spec (a `{:group .. :aggregates ..}` map)
  rather than a plain :ids/:entities/:count keyword."
  [ast]
  (map? (:return ast)))

(defn aggregate-vars
  "The (head) vars an aggregate :return references: its group keys + each
  aggregate's source. A field-path group/source contributes its head var (which
  must be bound), so these are the vars every UNION branch must bind."
  [ret]
  (->> (into (vec (:group ret)) (keep second) (:aggregates ret))
       (mapv #(if (field-ref? %) (field-var %) %))))

;; ---------------------------------------------------------------------------
;; Validate
;; ---------------------------------------------------------------------------

(defn- validate-aggregate-spec!
  [ret]
  (let [{:keys [group aggregates]} ret]
    (when-not (vector? group)
      (err! :validate ":return :group must be a list of vars"))
    (when-not (every? #(or (var? %) (field-ref? %)) group)
      (err! :validate (str ":return :group may only contain variables or field paths, got: "
                           (pr-str (remove #(or (var? %) (field-ref? %)) group)))))
    (when-not (and (vector? aggregates) (seq aggregates))
      (err! :validate ":return :aggregates must be a non-empty list"))
    (doseq [[op src] aggregates]
      (when-not (agg-ops op)
        (err! :validate (str ":return aggregate op " (pr-str op) " is not supported (one of "
                             (vec (sort agg-ops)) ")")))
      (if (agg-needs-source op)
        (when-not (or (var? src) (field-ref? src))
          (err! :validate (str ":return aggregate :" (name op) " needs a source (a value variable or field path)")))
        (when (some? src)
          (err! :validate (str ":return aggregate :" (name op) " takes no source variable")))))))

(defn- validate-shape!
  [ast]
  (let [agg? (aggregate? ast)]
    (if agg?
      (when (contains? ast :find)
        (err! :validate ":find is not used with an aggregate :return (group/aggregate instead)"))
      (do
        (when-not (and (vector? (:find ast)) (seq (:find ast)))
          (err! :validate ":find must be a non-empty list of vars"))
        (when-not (every? var? (:find ast))
          (err! :validate (str ":find may only contain vars, got: " (pr-str (remove var? (:find ast))))))
        ;; a dotted name is a field path, not an entity to return — reject it (a
        ;; ?-name with a dot passes var? but is not bindable). Use return: entities.
        (when-let [dotted (seq (filter #(str/includes? (name %) ".") (:find ast)))]
          (err! :validate (str ":find takes entity variables, not field paths: " (vec dotted)
                               " — use return \"entities\" to get full entities")))
        ;; ?__-prefixed names are reserved for internal columns (e.g. order-by's
        ;; hidden __ord_N projections); reject them to avoid alias collisions.
        (when-let [reserved (seq (filter #(str/starts-with? (name %) "?__") (:find ast)))]
          (err! :validate (str "Variable names beginning with ?__ are reserved: " (vec reserved))))
        ;; Find vars become SQL column aliases — the ONLY user-derived
        ;; identifier the compiler ever emits. Constrain the charset so a
        ;; hostile or typo'd name is a structured 400 HERE, instead of
        ;; relying on HoneySQL's suspicious-entity-check deep in the
        ;; compiler (an opaque 500 — and the only line of defense should
        ;; format options ever change).
        (when-let [bad (seq (remove #(re-matches #"\?[A-Za-z][A-Za-z0-9_-]*" (name %))
                                    (:find ast)))]
          (err! :validate (str ":find variable names must start with a letter and use only "
                               "letters, digits, '_' or '-': " (vec bad))))
        (when-not (apply distinct? (:find ast))
          (err! :validate (str ":find has duplicate variables: "
                               (pr-str (->> (:find ast) frequencies (keep (fn [[v n]] (when (> n 1) v))) vec))))))))
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
    (cond
      (map? r) (validate-aggregate-spec! r)
      (not (#{:ids :entities :count} r))
      (err! :validate (str ":return " (pr-str r) " is not supported (one of :ids, :entities, :count, or an aggregate spec)"))))
  (when (and (aggregate? ast) (:order-by ast))
    (err! :validate ":order-by is not supported with an aggregate :return (v0)"))
  ;; order-by entries are [field-ref dir]; the dir is a shape concern here, the
  ;; field/find-var checks happen in `validate` (they need inferred kinds).
  (doseq [[_fr dir] (:order-by ast)]
    (when-not (#{:asc :desc} dir)
      (err! :validate (str ":order-by direction must be asc or desc, got: " (pr-str dir)))))
  ast)

(defn- check-regex-spec!
  "Validate a `{:regex \"...\" :flags \"i\"?}` spec (`label` for error messages).
  Compiles the pattern so a malformed regex is a 400 here, not a UDF runtime error."
  [label spec]
  (let [{:keys [regex flags]} spec
        extra (remove #{:regex :flags} (keys spec))]
    (when (seq extra)
      (err! :validate (str label " regex spec has unknown key(s) " (vec extra) " (allowed :regex, :flags)")))
    (when-not (string? regex)
      (err! :validate (str label " regex must be a string, got: " (pr-str regex))))
    (when (> (count regex) regex-max-len)
      (err! :validate (str label " regex is too long (max " regex-max-len " chars)")))
    (when (and flags (or (not (string? flags)) (not (re-matches #"i*" flags))))
      (err! :validate (str label " regex flags " (pr-str flags) " unsupported (only \"i\")")))
    (try (re-pattern regex)
         (catch java.util.regex.PatternSyntaxException e
           (err! :validate (str label " has an invalid regex: " (.getMessage e)))))))

(defn- validate-regex-spec!
  [head k spec]
  (when-not (regex-keys k)
    (err! :validate (str ":" (name head) " constraint :" (name k)
                         " does not support a regex (allowed on " (vec (sort regex-keys)) ")")))
  (check-regex-spec! (str ":" (name k)) spec))

(defn- validate-metadata!
  "Validate a :metadata constraint value: a map of metadata-key -> value spec
  (literal, list, or regex map)."
  [head mv]
  (when-not (map? mv)
    (err! :validate (str ":" (name head) " :metadata must be a map of key -> value")))
  (doseq [[mk spec] mv]
    (when-not (string? mk)
      (err! :validate (str ":metadata keys must be strings, got: " (pr-str mk))))
    (cond
      (and (vector? spec) (empty? spec))
      (err! :validate (str ":metadata " (pr-str mk) " list must be non-empty"))
      (map? spec)
      (if (contains? spec :regex)
        (check-regex-spec! (str ":metadata " (pr-str mk)) spec)
        (err! :validate (str ":metadata " (pr-str mk) " map value must be a regex {:regex ..}"))))))

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
            (= k :metadata)
            (validate-metadata! head v)
            (vector? v)
            (do (when-not (alternation-keys k)
                  (err! :validate (str ":" (name head) " constraint :" (name k)
                                       " does not support a list value (alternation is allowed on "
                                       (vec (sort alternation-keys)) ")")))
                (when (empty? v)
                  (err! :validate (str ":" (name head) " constraint :" (name k) " list must be non-empty"))))
            (map? v)
            (cond
              (contains? v :regex) (validate-regex-spec! head k v)
              (contains? v :var)
              (do (when-not (scalar-keys k)
                    (err! :validate (str ":" (name head) " constraint :" (name k)
                                         " does not take a value variable (allowed on "
                                         (vec (sort scalar-keys)) ")")))
                  (when-not (var? (:var v))
                    (err! :validate (str ":" (name k) " :var must be a ?-variable, got: " (pr-str (:var v))))))
              :else
              (let [accepts (cond-> []
                              (regex-keys k)  (conj "a regex {:regex ..}")
                              (scalar-keys k) (conj "a value variable {:var ..}"))]
                (err! :validate (str ":" (name head) " constraint :" (name k)
                                     " has an unrecognized spec " (pr-str v)
                                     (if (seq accepts)
                                       (str " (expected " (str/join " or " accepts) ")")
                                       " (this constraint takes a literal or list, not a map value)"))))))))

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
                                 " (allowed: " (vec (sort allowed)) ")"))))
        ;; a structural slot references ONE parent layer: a layer variable or a
        ;; scalar reference (a layer id) — like :layer, no list (alternation)
        ;; or map (regex / value-variable).
        (doseq [[slot _] (layer-slots-for head) :when (contains? cmap slot)]
          (let [x (get cmap slot)]
            (when-not (or (var? x) (string? x) (number? x))
              (err! :validate (str ":" (name head) " :" (name slot)
                                   " must be a layer variable or a single layer reference"
                                   " (a layer id), got: " (pr-str x))))))
        ;; :name matches a layer by a literal string only (no value-var/regex/list
        ;; map) — reject a map/vector with a clean 400 rather than a 500 at compile.
        (doseq [k [:name] :when (contains? cmap k)]
          (let [x (get cmap k)]
            (when-not (or (string? x) (number? x))
              (err! :validate (str ":" (name head) " :" (name k) " must be a string ("
                                   (name head) " matches by exact name), got: " (pr-str x)))))))

      (= head :related*)
      (let [[a b cmap] args]
        (when-not (and (var? a) (var? b))
          (err! :validate ":related* takes two span variables, got: " (pr-str [a b])))
        (when (> (count args) 3)
          (err! :validate ":related* takes two span vars and a constraint map"))
        (when-not (and (map? cmap) (contains? cmap :layer))
          (err! :validate ":related* requires a constraint map with a :layer (the relation layer to follow)"))
        (let [allowed #{:layer :value}
              unknown (remove allowed (keys cmap))]
          (when (seq unknown)
            (err! :validate (str ":related* constraints may only be :layer and :value, got: " (vec unknown))))
          (when (symbol? (:layer cmap))
            (err! :validate ":related* :layer must be a relation-layer reference, not a variable"))
          ;; the compiler matches an edge's :value with literal `=` / list `IN`
          ;; only; a regex/value-variable map would silently compile to an
          ;; equality against the literal map text and never match. Reject it.
          (when-let [val (:value cmap)]
            (when (map? val)
              (err! :validate (str ":related* :value must be a literal or a list of literals; "
                                   "regex and value-variables are not supported on :related* edges"))))))

      (pred-ops head)
      (do
        (when-not (= (count args) 2)
          (err! :validate (str "Predicate :" (name head) " takes exactly 2 terms, got " (count args))))
        ;; a term is a var, a field path (a ::field map), or a scalar literal. A
        ;; non-field map / vector / non-var symbol is a clean 400 — not a silent
        ;; empty result or an uncaught HoneySQL 500 at compile.
        (doseq [t args]
          (cond
            (or (var? t) (field-ref? t)) nil
            (or (string? t) (number? t) (boolean? t)) nil
            :else (err! :validate (str "Predicate :" (name head) " term " (pr-str t)
                                       " is not a variable, field path, or literal")))))

      ;; `["~" field-path regex-spec]` — regex match. Shape only here; the LHS must be
      ;; a TEXT field, checked in `validate` once kinds are inferred.
      (= head op-match)
      (let [[lhs spec] args]
        (when-not (= (count args) 2)
          (err! :validate (str "~ takes a field path and a regex, got " (count args) " term(s)")))
        (when-not (field-ref? lhs)
          (err! :validate (str "~ left-hand side must be a field path (e.g. ?s.value), got: " (pr-str lhs))))
        (when-not (and (map? spec) (contains? spec :regex))
          (err! :validate (str "~ right-hand side must be a regex string or {:regex ..}, got: " (pr-str spec))))
        (check-regex-spec! "~" spec))

      ;; `[:in term [literal ..]]` — membership. Shape only here; a reference LHS
      ;; needs id (not name) members, checked in `validate`.
      (= head :in)
      (let [[lhs members] args]
        (when-not (= (count args) 2)
          (err! :validate (str "in takes a term and a list, got " (count args) " term(s)")))
        (when-not (or (field-ref? lhs) (var? lhs))
          (err! :validate (str "in left-hand side must be a field path or variable, got: " (pr-str lhs))))
        (when-not (and (sequential? members) (seq members))
          (err! :validate (str "in right-hand side must be a non-empty list of literals, got: " (pr-str members))))
        (when-not (every? scalar-literal? members)
          (err! :validate (str "in list may only contain literals, got: "
                               (pr-str (vec (remove scalar-literal? members)))))))

      (= head :not)
      (do
        (when (empty? args)
          (err! :validate ":not needs at least one clause to negate"))
        (when (some #(let [h (first %)] (or (pred-ops h) (attr-pred-ops h))) args)
          (err! :validate "Predicate clauses are not supported inside :not (v0)"))
        ;; recurse: the negated body is entity/relationship clauses and nested
        ;; :not (a nested NOT EXISTS); any :or/:seq inside a :not were already
        ;; De-Morganed away by `expand`.
        (run! validate-clause! args))

      :else
      (err! :validate (str "Unknown clause head :" (name head))))))

(defn- validate-field-ref!
  "Validate a field-ref term against the inferred `kinds`. `ordering?` true means
  it sits under an ordering predicate (< > <= >=), where opaque-id fields are
  rejected. Throws :code 400 on any problem."
  [kinds positive fr ordering?]
  (let [v (field-var fr)]
    (when-not (positive v)
      (err! :validate (str "Field path " (field->str fr) " references unbound variable " v)))
    (let [res (field-resolve (get kinds v) (field-path fr))]
      (when (:error res)
        (err! :validate (str "Field path " (field->str fr) ": " (:error res))))
      (when (and ordering? (#{:core :layer-attr} (:type res)) (unordered-field-attrs (:attr res)))
        (err! :validate (str "Field " (field->str fr) " is an id with no order; use = / != (not < > <= >=)")))
      (when (and ordering? (= :ref (:type res)))
        (err! :validate (str "Field " (field->str fr) " is a reference id with no order; use = / != (not < > <= >=)"))))))

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
    ;; scalar vars are join/predicate helpers; they bind a value, not an entity,
    ;; so they cannot be returned (v0).
    (doseq [v (:find ast)]
      (when (= :scalar (get kinds v))
        (err! :validate (str "Var " v " binds a value (not an entity) and cannot be a :find var"))))
    ;; predicate clauses: terms are field paths, vars, or literals. Every var/path
    ;; head must be positively bound; ordering ops (< > <= >=) are rejected on
    ;; entity/layer ids (no order) but allowed on scalar fields/value-vars.
    (doseq [clause (:where ast) :when (pred-ops (first clause))]
      (let [[op a b] clause
            ordering? (order-pred-ops op)]
        (doseq [t [a b]]
          (cond
            (field-ref? t) (validate-field-ref! kinds positive t ordering?)
            (var? t) (do (when-not (positive t)
                           (err! :validate (str "Predicate :" (name op) " references unbound var " t)))
                         (when (and ordering? (not= :scalar (get kinds t)))
                           (err! :validate (str "Predicate :" (name op) " cannot order entity/layer variables "
                                                "(ids are unordered); use := or :!="))))
            :else nil))
        ;; G4: a reference field (?s.layer / ?r.source / ?r.target) compares only to a
        ;; variable or an id literal, and the variable must be the KIND the reference
        ;; targets. Both guards exist for the same reason — a bare NAME, or a wrong-kind
        ;; var, silently compares the FK to a value it can never equal and matches
        ;; nothing. There is NO name resolution on this path (that lives in the
        ;; constraint map / a layer-var clause), and the constraint-map form rejects a
        ;; wrong-kind var as a kind conflict — so reject both loudly here too.
        (doseq [[t other] [[a b] [b a]] :when (field-ref? t)]
          (let [res (field-resolve (get kinds (field-var t)) (field-path t))]
            (when (= :ref (:type res))
              (when (and (not (var? other)) (not (field-ref? other)) (not (uuid-like? other)))
                (err! :validate (str "Field " (field->str t) " is a layer/entity reference; compare it to a "
                                     "variable or an id, not " (pr-str other)
                                     " — use a layer id or a layer-var clause for matching by name")))
              (when (var? other)
                (let [want (case (:attr res)
                             :layer (entity->layer-kind (get kinds (field-var t)))
                             (:source :target) :span)
                      got  (get kinds other)]
                  (when (and want got (not= got want))
                    (err! :validate (str "Field " (field->str t) " is a " (name (:attr res))
                                         " reference; " other " is a " (name got)
                                         ", expected a " (name want) " variable"))))))))))
    ;; `~` clauses: the LHS field must resolve to a TEXT field (value/form/name/body/
    ;; metadata/config). Reject numeric/opaque/reference fields with a clean 400.
    (doseq [clause (:where ast) :when (= op-match (first clause))]
      (let [lhs (second clause)]
        (validate-field-ref! kinds positive lhs false)
        (let [res (field-resolve (get kinds (field-var lhs)) (field-path lhs))
              text? (or (#{:metadata :config} (:type res))
                        (and (#{:core :layer-attr} (:type res))
                             (#{:value :form :name :body} (:attr res))))]
          (when-not text?
            (err! :validate (str "~ requires a text field on the left; " (field->str lhs)
                                 " is not a text field (regex matches text, not numbers/ids)"))))))
    ;; `:in` clauses: the LHS term must be bound; a reference LHS needs id members
    ;; (UUIDs), not names — same footgun as the G4 `=` check.
    (doseq [clause (:where ast) :when (= :in (first clause))]
      (let [[_ lhs members] clause]
        (cond
          (field-ref? lhs) (validate-field-ref! kinds positive lhs false)
          (var? lhs) (when-not (positive lhs)
                       (err! :validate (str "in references unbound var " lhs))))
        (when (field-ref? lhs)
          (let [res (field-resolve (get kinds (field-var lhs)) (field-path lhs))]
            (when (and (= :ref (:type res)) (not (every? uuid-like? members)))
              (err! :validate (str "in on reference field " (field->str lhs)
                                   " requires layer/entity ids (UUIDs), not names")))))))
    ;; order-by: each entry is [field-ref dir]; the head must be a :find var (so
    ;; the sort column is present in every UNION branch). Any field is sortable
    ;; (ids give a stable order), so ordering? is false here.
    (let [find-set (set (:find ast))]
      (doseq [[fr _dir] (:order-by ast)]
        (when-not (find-set (field-var fr))
          (err! :validate (str ":order-by may only reference :find vars; " (field-var fr) " is not selected")))
        (validate-field-ref! kinds positive fr false)))
    ;; aggregate spec: group keys + sources must be bound; a source is a value
    ;; variable or a field path (not an entity id), a group is a var or field path.
    (when (aggregate? ast)
      (let [ret (:return ast)]
        (doseq [v (aggregate-vars ret)]
          (when-not (positive v)
            (err! :validate (str ":return references unbound var " v))))
        (doseq [g (:group ret) :when (field-ref? g)]
          (validate-field-ref! kinds positive g false))
        (doseq [[op src] (:aggregates ret) :when src]
          (cond
            (field-ref? src) (validate-field-ref! kinds positive src false)
            (not= :scalar (get kinds src))
            (err! :validate (str ":return aggregate :" (name op) " source " src
                                 " must be a value variable or field path, not an entity"))))))
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

(defn- check-aggregate-branch-entities!
  "Under aggregation, the distinct-match key projects EVERY entity/layer var's id,
  so a UNION's branches must bind the SAME set of those vars (otherwise the branch
  projections have different shapes — a 500 from the SQL engine). Reject the
  mismatch with a clean 400."
  [branch-wheres]
  ;; Compare the vars actually PROJECTED per branch: positive (non-:not) entity/
  ;; layer vars — exactly the ids the distinct-match key emits. Keying off
  ;; `infer-kinds` instead would fold in `:not`-existential vars, so a var that is
  ;; positive in one branch but only inside a `:not` in another would look equal
  ;; here yet project a different column count -> a UNION-arity 500.
  (let [entity-sets (mapv (fn [w]
                            (let [kinds (infer-kinds {:where w})]
                              (set (remove #(= :scalar (get kinds %)) (positive-binding-vars w)))))
                          branch-wheres)]
    (when (apply not= entity-sets)
      (err! :validate (str "When aggregating over alternatives (:or/:seq), every alternative must bind the "
                           "same variables; got differing sets " (mapv (comp vec sort) entity-sets))))))

(defn expand
  "Parse + desugar (`:seq` / `:or`) + validate. Returns a NON-EMPTY vector of
  validated branch ASTs sharing the same :find/:scope/:limit/:return; the executor
  UNIONs them. This is the entry point the query endpoint uses (handles the
  disjunctive sugar, unlike `parse+validate`)."
  [raw]
  (let [parsed (parse raw)
        base (dissoc parsed :where)
        agg? (aggregate? parsed)
        ;; the vars projected through the UNION: :find normally, or the aggregate
        ;; spec's group + source vars in aggregate mode. Every branch must bind them.
        projected (if agg? (aggregate-vars (:return parsed)) (:find parsed))
        branch-wheres (expand-where (vec (:where parsed)))]
    (when (> (count branch-wheres) 1)
      (check-branch-consistency! branch-wheres projected)
      (when agg? (check-aggregate-branch-entities! branch-wheres)))
    (mapv (fn [w] (validate (assoc base :where (vec w)))) branch-wheres)))
