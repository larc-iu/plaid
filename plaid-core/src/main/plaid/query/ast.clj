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
(def ^:private deferred-clauses
  #{:seq})

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
  "Constraint map: keyword-ize keys, var-ize values that look like vars
  (so `:source ?h` works), leave scalar values alone."
  [m]
  (when-not (map? m)
    (err! :parse (str "Clause constraint must be a map, got: " (pr-str m))))
  (reduce-kv (fn [acc k v] (assoc acc (->kw k) (->var v))) {} m))

(defn- normalize-clause
  [clause]
  (when-not (and (sequential? clause) (seq clause))
    (err! :parse (str "Each :where clause must be a non-empty vector, got: " (pr-str clause))))
  (let [head (->kw (first clause))
        args (rest clause)]
    (into [head]
          (map (fn [a] (if (map? a) (normalize-constraints a) (->var a))))
          args)))

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
      (contains? m :return) (assoc :return (->kw (:return m)))
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

(defn- clause-kinds
  "The (var -> kind) bindings a single clause asserts."
  [kinds clause]
  (let [[head & args] clause]
    (cond
      (contains? entity-clauses head)
      (let [[v cmap] args
            kinds (assoc-kind kinds v head)]
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
      :else kinds)))

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
    (when-not (= r :ids)
      (err! :validate (str ":return " (pr-str r) " is not supported in v0 (only :ids)"))))
  ast)

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
                                 " (allowed: " (vec (sort allowed)) ")")))))

      (contains? rel-clauses head)
      (let [arity (rel-clauses head)]
        (when-not (= (count args) arity)
          (err! :validate (str "Clause :" (name head) " takes " arity " vars, got " (count args))))
        (when-not (every? var? args)
          (err! :validate (str "Clause :" (name head) " arguments must all be vars, got: " (pr-str (vec args))))))

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
        find-unbound (remove kinds (:find ast))]
    (when (seq find-unbound)
      (err! :validate (str "Var(s) " (vec find-unbound) " in :find are never bound by any :where clause")
            {:vars (vec find-unbound)}))
    (-> ast
        (assoc :return (or (:return ast) :ids))
        (assoc ::var-kinds kinds))))

(defn parse+validate
  "Convenience: parse a raw body then validate. Returns the checked canonical AST."
  [raw]
  (validate (parse raw)))
