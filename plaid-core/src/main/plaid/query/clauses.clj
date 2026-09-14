(ns plaid.query.clauses
  "The vocabulary of the query language: which clause heads exist, what each
  one takes, which constraint keys accept which kind of value, and what a
  dotted field path means for a given kind.

  Tables only, plus the small functions that read straight off them — the
  400 helper `err!`, the var/field-reference predicates, `field-resolve`, and
  var-kind inference. Nothing here parses a request body, validates one, or
  desugars anything; `plaid.query.ast`, `plaid.query.validate` and
  `plaid.query.desugar` each do one of those on top of this.

  Split out of `plaid.query.ast` so all three, and the compiler, read one
  definition of the language rather than three."
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
(def entity-clauses
  {:span     #{:layer :value :doc :metadata}
   ;; :token :value is the SURFACE substring (text body[begin,end]) — computed, the
   ;; domain's :token/value — not an annotation like span/relation :value.
   :token    #{:layer :value :doc :begin :end :metadata}
   :relation #{:layer :value :doc :source :target :metadata}
   :vocab    #{:layer :form :metadata}
   :document #{:name :id :metadata}
   :text     #{:body :doc :metadata}
   ;; a vocab link as an entity of its own (its metadata carries provenance; a
   ;; link over several tokens is a multi-word expression). :item is the vocab
   ;; item it points at: a vocab variable (binds/joins) or an item id (or a list).
   :link     #{:item :doc :metadata}})

;; Constraint keys whose value may be a vector = "one of" (compiles to IN). The
;; literal-match keys only — NOT :layer (multi-layer is unique-or-400 / future
;; layer vars) or :source/:target (vars). :item takes a list of item ids.
(def alternation-keys #{:value :form :doc :begin :end :name :body :id :item})

;; Constraint keys whose value may be a regex spec `{:regex "..." :flags "i"?}`
;; (compiles to a REGEXP match). Text-valued keys only.
(def regex-keys #{:value :form :name :body})
(def regex-max-len 512)

;; Constraint keys whose value may be a SCALAR VARIABLE: `{:value "?v"}` binds
;; `?v` to that column instead of filtering, so the same `?v` in two clauses is a
;; column-equality join (e.g. two spans with the *same* value). Scalar vars are a
;; distinct kind (`:scalar`) — not an entity, not selectable in :find (v0).
(def scalar-keys #{:value :form :begin :end :doc})

;; Predicate clauses compare two already-bound terms: `[:= ?a ?b]`, `[:!= ?s1 ?s2]`,
;; `[:< ?n 5]`. A term is a var or a literal. Entity-var comparisons are := / :!=
;; only (ids are unordered); scalar/literal terms allow the ordering ops too.
(def pred-ops #{:= :!= :< :> :<= :>=})
(def order-pred-ops #{:< :> :<= :>=})

;; "Attribute predicate" clauses — the Datalog-style decomposition of constraint-map
;; entries: `["~" ?s.value {:regex ..}]` (regex, the standalone form of the `:value
;; {:regex}` constraint) and `["in" ?s.value [..]]` (membership, the standalone form
;; of a list/alternation constraint). Compiled on the predicate path (no desugar).
;; The regex head is the keyword named "~"; `:~` is not a readable literal (`~` is the
;; unquote reader macro), so it is constructed and referenced through `op-match`. Using
;; the literal "~" (not a word like "match") also means no other wire token aliases it.
;; Public so the compiler shares this one definition (the dispatch matches on it).
(def op-match (keyword "~"))
(def attr-pred-ops #{op-match :in})

;; Aggregate ops for `:return {:group [...] :aggregates [[op src?]...]}`. `:count`
;; counts matches (no source); the rest aggregate a scalar variable. SUM/AVG
;; assume the scalar is numeric; MIN/MAX work on anything comparable.
(def agg-ops #{:count :sum :avg :min :max})
(def agg-needs-source #{:sum :avg :min :max})

;; Layer-constraint clauses: [:span-layer ?sl {constraint-map}]. The head IS the
;; layer kind; binds/constrains a LAYER variable. Value = allowed constraint keys.
;; Besides its own attribute (:name) a layer clause may name its immutable
;; PARENT layer through a structural slot (see `layer-slot->kind`). `:text-layer` is
;; a queryable kind only so a token layer's text-layer parent can be bound/constrained.
(def layer-clauses
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
(def var-slots
  (into #{:source :target :layer :item} (map second) (keys layer-slot->kind)))

;; Relationship clauses and the KIND of each var argument, in order. Arity is the
;; count, and `clause-kinds` reads the kinds straight off this table — one home,
;; so a clause added here cannot be missed by kind inference (which used to
;; degrade to a 500 when it was).
(def rel-clauses
  {:covers      [:span :token]           ; the span covers that token
   :precedes    [:token :token]          ; immediate
   :precedes*   [:token :token]          ; transitive
   :source      [:relation :span]
   :target      [:relation :span]
   :within      [:token :token]          ; [:within ?child ?parent] offset containment
   :first-in    [:token :token]          ; [:first-in ?token ?container]
   :overlaps    [:span :span]            ; spans share a covered token
   :contains    [:span :span]            ; span ?a covers every token ?b does
   :coextensive [:span :span]            ; spans cover the same tokens
   :vocab-link  [:token :vocab]          ; the token is linked to the item (no link entity)
   :link-token  [:link :token]           ; the link covers that token
   :link-item   [:link :vocab]})         ; the link points at that item

;; `:related*` is a relationship over the same two span vars but takes a trailing
;; constraint map, so it validates in its own branch. Its argument kinds live
;; here beside the rest.
(def ^:private rel-arg-kinds
  (assoc rel-clauses :related* [:span :span]))

;; Clause heads accepted by the grammar but not implemented until a later
;; milestone. Rejected by validate with a "not yet supported" message rather
;; than an "unknown clause" one, so the surface stays forward-compatible.
;; (Empty now that :seq landed in M3 — the mechanism is retained for the next
;; deferral.)
(def deferred-clauses
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
   :text     #{:body :doc :id}
   :link     #{:doc :id :item}})

;; Reference fields: a dot-path to a FK id column (a layer, a relation endpoint,
;; or a link's item). They behave like opaque ids — only `=` / `!=` / `in`
;; against a variable or an id literal (no ordering, no name resolution — see
;; the G4 check in `validate`).
(def ^:private ref-attrs #{:layer :source :target :item})

;; Layer variables expose name/id as scalar fields, plus open `config` keys.
(def ^:private layer-field-attrs #{:name :id})

;; Fields with no meaningful order (opaque ids): ordering predicate ops
;; (< > <= >=) are rejected on these, though `=`/`!=` and order-by are fine.
(def unordered-field-attrs #{:id :doc})

;; A scalar literal: the only thing a binding, an `in` list or a `{:literal …}`
;; wrapper may carry. Nil is not one — a metadata key whose value is null is
;; deleted, so no row can hold one.
(defn scalar-literal? [x]
  (or (string? x) (number? x) (boolean? x)))

;; ---------------------------------------------------------------------------
;; Errors
;; ---------------------------------------------------------------------------

(defn err!
  ([stage msg] (err! stage msg {}))
  ([stage msg data]
   (throw (ex-info msg (merge {:code 400 :query-error/stage stage} data)))))

(defn uuid-like?
  "True if `s` looks like a UUID. Used to keep `?s.layer`/`?r.source`/`?r.target`
  reference comparisons to a variable or an id — a bare name literal is a loud 400,
  not a silent compare-to-string. (Local regex so the query AST stays
  backend-agnostic.)"
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

(def field-key ::field)
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
         :layer :source :target :item]))

(defn dotted-name? [x]
  (let [n (cond (symbol? x) (name x) (string? x) x :else nil)]
    (boolean (and n (str/starts-with? n "?") (str/includes? n ".")))))

(defn ->field-ref [x]
  (let [n (if (symbol? x) (name x) x)
        parts (str/split n #"\.")]
    (when (some str/blank? parts)
      (err! :parse (str "Malformed field path " (pr-str x) " (empty path segment)")))
    {field-key {:var (symbol (first parts)) :path (vec (rest parts))}}))

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
(def entity->layer-kind
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
                          kinds [:source :target])
            ;; :link's inline :item var is a vocab item
            kinds (if (var? (:item cmap))
                    (assoc-kind kinds (:item cmap) :vocab)
                    kinds)]
        ;; a {:var ?v} in a scalar-key value (:value/:form/:begin/:end/:doc) is a scalar var
        (reduce (fn [kk sk]
                  (let [x (get cmap sk)]
                    (if (and (map? x) (var? (:var x))) (assoc-kind kk (:var x) :scalar) kk)))
                kinds scalar-keys))

      ;; a relationship clause binds each argument to the kind `rel-arg-kinds`
      ;; declares for that position (a trailing constraint map, as :related* has,
      ;; falls off the end of the zip)
      (contains? rel-arg-kinds head)
      (reduce (fn [kk [v k]] (assoc-kind kk v k)) kinds (map vector args (rel-arg-kinds head)))

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
            (into (keep #(let [x (get cmap %)] (when (var? x) x)) [:source :target :layer :item]))
            (into (keep #(let [x (get cmap %)] (when (and (map? x) (var? (:var x))) (:var x))) scalar-keys))))
      ;; a relationship clause's args are its vars (a trailing constraint map, as
      ;; :related* has, filters out)
      (contains? rel-arg-kinds head) (filterv var? args)
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
