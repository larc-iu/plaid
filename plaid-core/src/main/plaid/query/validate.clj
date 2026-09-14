(ns plaid.query.validate
  "Semantic validation of a canonical query AST.

  `validate` is the whole surface: shape checks, per-clause checks against the
  tables in `plaid.query.clauses`, var-kind inference with conflict detection,
  and the safety checks that every `:find` var is positively bound and every
  field path resolves for the kind its head var binds. It returns the AST with
  `:return` defaulted and the inferred kinds attached, or throws
  `(ex-info msg {:code 400 …})`.

  Called by `plaid.query.ast/parse+validate` and once per expanded branch by
  `plaid.query.ast/expand` — nothing else needs it."
  (:refer-clojure :exclude [var?])
  (:require [clojure.string :as str]
            [plaid.query.clauses :as clauses :refer [err! var?]]))

;; ---------------------------------------------------------------------------
;; Validate
;; ---------------------------------------------------------------------------

(defn- validate-aggregate-spec!
  [ret]
  (let [{:keys [group aggregates]} ret]
    (when-not (vector? group)
      (err! :validate ":return :group must be a list of vars"))
    (when-not (every? #(or (var? %) (clauses/field-ref? %)) group)
      (err! :validate (str ":return :group may only contain variables or field paths, got: "
                           (pr-str (remove #(or (var? %) (clauses/field-ref? %)) group)))))
    (when-not (and (vector? aggregates) (seq aggregates))
      (err! :validate ":return :aggregates must be a non-empty list"))
    (doseq [[op src] aggregates]
      (when-not (clauses/agg-ops op)
        (err! :validate (str ":return aggregate op " (pr-str op) " is not supported (one of "
                             (vec (sort clauses/agg-ops)) ")")))
      (if (clauses/agg-needs-source op)
        (when-not (or (var? src) (clauses/field-ref? src))
          (err! :validate (str ":return aggregate :" (name op) " needs a source (a value variable or field path)")))
        (when (some? src)
          (err! :validate (str ":return aggregate :" (name op) " takes no source variable")))))))

(defn- validate-shape!
  [ast]
  (let [agg? (clauses/aggregate? ast)]
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
  (when (and (clauses/aggregate? ast) (:order-by ast))
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
    (when (> (count regex) clauses/regex-max-len)
      (err! :validate (str label " regex is too long (max " clauses/regex-max-len " chars)")))
    (when (and flags (or (not (string? flags)) (not (re-matches #"i*" flags))))
      (err! :validate (str label " regex flags " (pr-str flags) " unsupported (only \"i\")")))
    (try (re-pattern regex)
         (catch java.util.regex.PatternSyntaxException e
           (err! :validate (str label " has an invalid regex: " (.getMessage e)))))))

(defn- validate-regex-spec!
  [head k spec]
  (when-not (clauses/regex-keys k)
    (err! :validate (str ":" (name head) " constraint :" (name k)
                         " does not support a regex (allowed on " (vec (sort clauses/regex-keys)) ")")))
  (check-regex-spec! (str ":" (name k)) spec))

(defn- check-literal-spec!
  "Validate a `{:literal v}` spec (`label` for error messages): the escape
  hatch for a metadata value that a bare spelling would read as something
  else, such as one that begins with `?`."
  [label spec]
  (let [extra (remove #{:literal} (keys spec))
        v (:literal spec)]
    (when (seq extra)
      (err! :validate (str label " literal spec has unknown key(s) " (vec extra) " (allowed :literal)")))
    (when (nil? v)
      (err! :validate (str label " literal must not be null: a metadata key whose value is null "
                           "is deleted, so no row can hold one")))
    (when (and (vector? v) (empty? v))
      (err! :validate (str label " literal list must be non-empty")))))

(defn- validate-metadata!
  "Validate a :metadata constraint value: a map of metadata-key -> value spec
  (literal, list, regex map, or literal map)."
  [head mv]
  (when-not (map? mv)
    (err! :validate (str ":" (name head) " :metadata must be a map of key -> value")))
  (doseq [[mk spec] mv]
    (when-not (string? mk)
      (err! :validate (str ":metadata keys must be strings, got: " (pr-str mk))))
    (cond
      ;; A var here reads as a literal and can never match, so the query comes
      ;; back empty rather than wrong-looking: the same footgun as a bare form
      ;; on :item, and a 400 for the same reason. Metadata is matched, not
      ;; bound. Asking whether a key is SET at all is a regex that matches
      ;; anything, which is how the apps count senses. A value that really does
      ;; begin with `?` (a gloss like "?PL") goes in {"literal": …}.
      (or (var? spec) (and (string? spec) (str/starts-with? spec "?")))
      (err! :validate (str ":metadata " (pr-str mk) " cannot bind a variable: metadata is matched, "
                           "not bound. Use a literal, a list of literals, or a regex "
                           "{\"regex\": \"…\"} — {\"regex\": \".*\"} matches any row that has "
                           "the key at all. For a value that really does begin with '?', "
                           "write {\"literal\": " (pr-str (str spec)) "}."))
      (and (vector? spec) (empty? spec))
      (err! :validate (str ":metadata " (pr-str mk) " list must be non-empty"))
      (map? spec)
      (cond
        (contains? spec :regex) (check-regex-spec! (str ":metadata " (pr-str mk)) spec)
        (contains? spec :literal) (check-literal-spec! (str ":metadata " (pr-str mk)) spec)
        :else
        (err! :validate (str ":metadata " (pr-str mk) " map value must be a regex {:regex ..} "
                             "or a literal {:literal ..}"))))))

(defn- validate-clause!
  [clause]
  (let [[head & args] clause]
    (cond
      (contains? clauses/deferred-clauses head)
      (err! :validate (str "Clause :" (name head) " is recognized but not yet supported in v0"))

      (contains? clauses/entity-clauses head)
      (let [[v cmap] args]
        (when-not (var? v)
          (err! :validate (str "Entity clause :" (name head) " needs a var as its first argument, got: "
                               (pr-str v))))
        (when (and (some? cmap) (not (map? cmap)))
          (err! :validate (str "Entity clause :" (name head) " constraints must be a map, got: " (pr-str cmap))))
        (when (> (count args) 2)
          (err! :validate (str "Entity clause :" (name head) " takes at most a var and a constraint map")))
        (let [allowed (clauses/entity-clauses head)
              unknown (remove allowed (keys (or cmap {})))]
          (when (seq unknown)
            (err! :validate (str "Unknown constraint key(s) " (vec unknown) " on :" (name head)
                                 " (allowed: " (vec (sort allowed)) ")"))))
        ;; a link's :item is a reference: a vocab variable, an item id, or a list of
        ;; ids. A bare form would silently compare the FK to a value it can never
        ;; equal (the same footgun as a layer name), so it is a 400 here.
        (when (contains? cmap :item)
          (let [x (:item cmap)
                id? #(or (uuid? %) (clauses/uuid-like? %))]
            (when-not (or (var? x) (id? x)
                          (and (vector? x) (seq x) (every? id? x)))
              (err! :validate (str ":" (name head) " :item must be a vocab variable, an item id, or a list of "
                                   "item ids, got: " (pr-str x)
                                   " — to match an entry by form, bind it with [\"vocab\" \"?v\" {\"form\" \"…\"}]")))))
        ;; value shapes: a vector value means "one of" -> IN (alternation, on the
        ;; literal-match keys only); a map value means a regex spec (clauses/regex-keys
        ;; only). A scalar is plain equality.
        (doseq [[k v] cmap]
          (cond
            (= k :metadata)
            (validate-metadata! head v)
            (vector? v)
            (do (when-not (clauses/alternation-keys k)
                  (err! :validate (str ":" (name head) " constraint :" (name k)
                                       " does not support a list value (alternation is allowed on "
                                       (vec (sort clauses/alternation-keys)) ")")))
                (when (empty? v)
                  (err! :validate (str ":" (name head) " constraint :" (name k) " list must be non-empty"))))
            (map? v)
            (cond
              (contains? v :regex) (validate-regex-spec! head k v)
              (contains? v :var)
              (do (when-not (clauses/scalar-keys k)
                    (err! :validate (str ":" (name head) " constraint :" (name k)
                                         " does not take a value variable (allowed on "
                                         (vec (sort clauses/scalar-keys)) ")")))
                  (when-not (var? (:var v))
                    (err! :validate (str ":" (name k) " :var must be a ?-variable, got: " (pr-str (:var v))))))
              :else
              (let [accepts (cond-> []
                              (clauses/regex-keys k)  (conj "a regex {:regex ..}")
                              (clauses/scalar-keys k) (conj "a value variable {:var ..}"))]
                (err! :validate (str ":" (name head) " constraint :" (name k)
                                     " has an unrecognized spec " (pr-str v)
                                     (if (seq accepts)
                                       (str " (expected " (str/join " or " accepts) ")")
                                       " (this constraint takes a literal or list, not a map value)"))))))))

      (contains? clauses/rel-clauses head)
      (let [arity (count (clauses/rel-clauses head))]
        (when-not (= (count args) arity)
          (err! :validate (str "Clause :" (name head) " takes " arity " vars, got " (count args))))
        (when-not (every? var? args)
          (err! :validate (str "Clause :" (name head) " arguments must all be vars, got: " (pr-str (vec args))))))

      (contains? clauses/layer-clauses head)
      (let [[v cmap] args]
        (when-not (var? v)
          (err! :validate (str "Layer clause :" (name head) " needs a layer var as its first argument, got: " (pr-str v))))
        (when (and (some? cmap) (not (map? cmap)))
          (err! :validate (str "Layer clause :" (name head) " constraints must be a map, got: " (pr-str cmap))))
        (let [allowed (clauses/layer-clauses head)
              unknown (remove allowed (keys (or cmap {})))]
          (when (seq unknown)
            (err! :validate (str "Unknown constraint key(s) " (vec unknown) " on :" (name head)
                                 " (allowed: " (vec (sort allowed)) ")"))))
        ;; a structural slot references ONE parent layer: a layer variable or a
        ;; scalar reference (a layer id) — like :layer, no list (alternation)
        ;; or map (regex / value-variable).
        (doseq [[slot _] (clauses/layer-slots-for head) :when (contains? cmap slot)]
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
          (err! :validate (str ":related* takes two span variables, got: " (pr-str [a b]))))
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

      (clauses/pred-ops head)
      (do
        (when-not (= (count args) 2)
          (err! :validate (str "Predicate :" (name head) " takes exactly 2 terms, got " (count args))))
        ;; a term is a var, a field path (a ::field map), or a scalar literal. A
        ;; non-field map / vector / non-var symbol is a clean 400 — not a silent
        ;; empty result or an uncaught HoneySQL 500 at compile.
        (doseq [t args]
          (cond
            (or (var? t) (clauses/field-ref? t)) nil
            (or (string? t) (number? t) (boolean? t)) nil
            :else (err! :validate (str "Predicate :" (name head) " term " (pr-str t)
                                       " is not a variable, field path, or literal")))))

      ;; `["~" field-path regex-spec]` — regex match. Shape only here; the LHS must be
      ;; a TEXT field, checked in `validate` once kinds are inferred.
      (= head clauses/op-match)
      (let [[lhs spec] args]
        (when-not (= (count args) 2)
          (err! :validate (str "~ takes a field path and a regex, got " (count args) " term(s)")))
        (when-not (clauses/field-ref? lhs)
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
        (when-not (or (clauses/field-ref? lhs) (var? lhs))
          (err! :validate (str "in left-hand side must be a field path or variable, got: " (pr-str lhs))))
        (when-not (and (sequential? members) (seq members))
          (err! :validate (str "in right-hand side must be a non-empty list of literals, got: " (pr-str members))))
        (when-not (every? clauses/scalar-literal? members)
          (err! :validate (str "in list may only contain literals, got: "
                               (pr-str (vec (remove clauses/scalar-literal? members)))))))

      (= head :not)
      (do
        (when (empty? args)
          (err! :validate ":not needs at least one clause to negate"))
        (when (some #(let [h (first %)] (or (clauses/pred-ops h) (clauses/attr-pred-ops h))) args)
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
  (let [v (clauses/field-var fr)]
    (when-not (positive v)
      (err! :validate (str "Field path " (clauses/field->str fr) " references unbound variable " v)))
    (let [res (clauses/field-resolve (get kinds v) (clauses/field-path fr))]
      (when (:error res)
        (err! :validate (str "Field path " (clauses/field->str fr) ": " (:error res))))
      (when (and ordering? (#{:core :layer-attr} (:type res)) (clauses/unordered-field-attrs (:attr res)))
        (err! :validate (str "Field " (clauses/field->str fr) " is an id with no order; use = / != (not < > <= >=)")))
      (when (and ordering? (= :ref (:type res)))
        (err! :validate (str "Field " (clauses/field->str fr) " is a reference id with no order; use = / != (not < > <= >=)"))))))

(defn validate
  "Validate a canonical AST. Runs shape checks, per-clause checks, var-kind
  inference (conflict detection), and the safety check (every :find var is
  bound somewhere in :where). Returns the AST with `:return` defaulted to
  `:ids` and `:plaid.query.ast/var-kinds` attached. Throws `:code 400` on any
  problem."
  [ast]
  (validate-shape! ast)
  (run! validate-clause! (:where ast))
  (let [kinds (clauses/infer-kinds ast)
        positive (clauses/positive-binding-vars (:where ast))
        find-unbound (remove positive (:find ast))]
    (when (seq find-unbound)
      (err! :validate (str "Var(s) " (vec find-unbound) " in :find are never positively bound "
                           "(a var that appears only inside :not is not bound)")
            {:vars (vec find-unbound)}))
    ;; A :where made only of :not (or only of predicates) binds nothing
    ;; positively, so there is no table to select from and the compiler emits
    ;; SELECT DISTINCT <nothing> FROM <nothing>. The :find check above catches
    ;; that whenever :find is used; an aggregate :return has no :find, so check
    ;; the shape itself and keep the 500 off this path.
    (when (empty? positive)
      (err! :validate (str ":where binds nothing: it needs at least one positive entity or layer clause "
                           "(a :where of only :not or predicate clauses has nothing to match)")))
    ;; scalar vars are join/predicate helpers; they bind a value, not an entity,
    ;; so they cannot be returned (v0).
    (doseq [v (:find ast)]
      (when (= :scalar (get kinds v))
        (err! :validate (str "Var " v " binds a value (not an entity) and cannot be a :find var"))))
    ;; predicate clauses: terms are field paths, vars, or literals. Every var/path
    ;; head must be positively bound; ordering ops (< > <= >=) are rejected on
    ;; entity/layer ids (no order) but allowed on scalar fields/value-vars.
    (doseq [clause (:where ast) :when (clauses/pred-ops (first clause))]
      (let [[op a b] clause
            ordering? (clauses/order-pred-ops op)]
        (doseq [t [a b]]
          (cond
            (clauses/field-ref? t) (validate-field-ref! kinds positive t ordering?)
            (var? t) (do (when-not (positive t)
                           (err! :validate (str "Predicate :" (name op) " references unbound var " t
                                                ". For a literal value that begins with '?', write {\"literal\": "
                                                (pr-str (str t)) "}.")))
                         (when (and ordering? (not= :scalar (get kinds t)))
                           (err! :validate (str "Predicate :" (name op) " cannot order entity/layer variables "
                                                "(ids are unordered); use := or :!="))))
            :else nil))
        ;; An entity/layer VARIABLE compares on its id, so the same rule the
        ;; reference-field guard below applies has to apply here: a bare name on
        ;; the other side compiles to `id = 'NOUN'` and matches nothing. Loud 400.
        (doseq [[t other] [[a b] [b a]]
                :when (and (var? t) (some? (get kinds t)) (not= :scalar (get kinds t)))]
          (when (and (not (var? other)) (not (clauses/field-ref? other)) (not (clauses/uuid-like? other)))
            (err! :validate (str "Var " t " is a " (name (get kinds t)) " and compares on its id; compare it "
                                 "to a variable or an id, not " (pr-str other)
                                 ". To match by value, constrain the clause (for example "
                                 "[\"span\", " (pr-str (str t)) ", {\"value\": " (pr-str other) "}])."))))
        ;; G4: a reference field (?s.layer / ?r.source / ?r.target) compares only to a
        ;; variable or an id literal, and the variable must be the KIND the reference
        ;; targets. Both guards exist for the same reason — a bare NAME, or a wrong-kind
        ;; var, silently compares the FK to a value it can never equal and matches
        ;; nothing. There is NO name resolution on this path (that lives in the
        ;; constraint map / a layer-var clause), and the constraint-map form rejects a
        ;; wrong-kind var as a kind conflict — so reject both loudly here too.
        (doseq [[t other] [[a b] [b a]] :when (clauses/field-ref? t)]
          (let [res (clauses/field-resolve (get kinds (clauses/field-var t)) (clauses/field-path t))]
            (when (= :ref (:type res))
              (when (and (not (var? other)) (not (clauses/field-ref? other)) (not (clauses/uuid-like? other)))
                (err! :validate (str "Field " (clauses/field->str t) " is a layer/entity reference; compare it to a "
                                     "variable or an id, not " (pr-str other)
                                     " — use a layer id or a layer-var clause for matching by name")))
              (when (var? other)
                (let [want (case (:attr res)
                             :layer (clauses/entity->layer-kind (get kinds (clauses/field-var t)))
                             (:source :target) :span
                             :item :vocab)
                      got  (get kinds other)]
                  (when (and want got (not= got want))
                    (err! :validate (str "Field " (clauses/field->str t) " is a " (name (:attr res))
                                         " reference; " other " is a " (name got)
                                         ", expected a " (name want) " variable"))))))))))
    ;; `~` clauses: the LHS field must resolve to a TEXT field (value/form/name/body/
    ;; metadata/config). Reject numeric/opaque/reference fields with a clean 400.
    (doseq [clause (:where ast) :when (= clauses/op-match (first clause))]
      (let [lhs (second clause)]
        (validate-field-ref! kinds positive lhs false)
        (let [res (clauses/field-resolve (get kinds (clauses/field-var lhs)) (clauses/field-path lhs))
              text? (or (#{:metadata :config} (:type res))
                        (and (#{:core :layer-attr} (:type res))
                             (#{:value :form :name :body} (:attr res))))]
          (when-not text?
            (err! :validate (str "~ requires a text field on the left; " (clauses/field->str lhs)
                                 " is not a text field (regex matches text, not numbers/ids)"))))))
    ;; `:in` clauses: the LHS term must be bound; a reference LHS needs id members
    ;; (UUIDs), not names — same footgun as the G4 `=` check.
    (doseq [clause (:where ast) :when (= :in (first clause))]
      (let [[_ lhs members] clause]
        (cond
          (clauses/field-ref? lhs) (validate-field-ref! kinds positive lhs false)
          (var? lhs) (when-not (positive lhs)
                       (err! :validate (str "in references unbound var " lhs))))
        (when (clauses/field-ref? lhs)
          (let [res (clauses/field-resolve (get kinds (clauses/field-var lhs)) (clauses/field-path lhs))]
            (when (and (= :ref (:type res)) (not (every? clauses/uuid-like? members)))
              (err! :validate (str "in on reference field " (clauses/field->str lhs)
                                   " requires layer/entity ids (UUIDs), not names")))))
        ;; the same rule for a bare entity/layer var, which `in` compares on its
        ;; id exactly as `=` does. This is the other route into the footgun the
        ;; `=` guard above closes.
        (when (var? lhs)
          (let [kind (get kinds lhs)]
            (when (and (some? kind) (not= :scalar kind) (not (every? clauses/uuid-like? members)))
              (err! :validate (str "in on " lhs " (a " (name kind) ") compares its id, so the list "
                                   "must be ids (UUIDs), not names. To match by value, constrain the "
                                   "clause or use a field path such as " lhs ".value.")))))))
    ;; order-by: each entry is [field-ref dir]; the head must be a :find var (so
    ;; the sort column is present in every UNION branch). Any field is sortable
    ;; (ids give a stable order), so ordering? is false here.
    (let [find-set (set (:find ast))]
      (doseq [[fr _dir] (:order-by ast)]
        (when-not (find-set (clauses/field-var fr))
          (err! :validate (str ":order-by may only reference :find vars; " (clauses/field-var fr) " is not selected")))
        (validate-field-ref! kinds positive fr false)))
    ;; aggregate spec: group keys + sources must be bound; a source is a value
    ;; variable or a field path (not an entity id), a group is a var or field path.
    (when (clauses/aggregate? ast)
      (let [ret (:return ast)]
        (doseq [v (clauses/aggregate-vars ret)]
          (when-not (positive v)
            (err! :validate (str ":return references unbound var " v))))
        (doseq [g (:group ret) :when (clauses/field-ref? g)]
          (validate-field-ref! kinds positive g false))
        (doseq [[op src] (:aggregates ret) :when src]
          (cond
            (clauses/field-ref? src) (validate-field-ref! kinds positive src false)
            (not= :scalar (get kinds src))
            (err! :validate (str ":return aggregate :" (name op) " source " src
                                 " must be a value variable or field path, not an entity"))))))
    (-> ast
        (assoc :return (or (:return ast) :ids))
        ;; Spelled out rather than `::var-kinds`: the key belongs to the AST
        ;; that `plaid.query.ast` publishes, and the compiler and the executor
        ;; read it as `::ast/var-kinds`.
        (assoc :plaid.query.ast/var-kinds kinds))))
