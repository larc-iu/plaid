(ns plaid.sql.query.resolve
  "Resolution stage of the query pipeline: turn the user's project scope and
  symbolic layer references into concrete project-id and layer-id sets, reading
  the SQL layer/project tables. This is where ACL is anchored — `effective-scope`
  is the ONLY universe layer references are searched in, so every layer id the
  compiler later inlines belongs to a project the user may read.

  Produces a *resolved AST*: the input AST with `::scope` (a set of project-id
  strings) attached, and every entity clause that names a `:layer` annotated with
  `::layer-ids` (a vector of concrete layer-id strings). Layer-less clauses are
  left untouched — the compiler scopes them via a defense-in-depth join.

  All ids are normalized to strings here (SQLite stores them as TEXT; params work
  as either string or UUID, and strings keep set operations unambiguous)."
  (:require [clojure.set :as set]
            [clojure.string :as str]
            [plaid.query.ast :as ast]
            [plaid.sql.common :as psc]
            [plaid.sql.project :as prj]
            [plaid.sql.user :as usr]))

;; Kind -> its layer table. Keyed both by ENTITY kind (resolving an entity's :layer
;; ref) and by LAYER kind (resolving a structural slot's parent-layer ref, e.g. a
;; token layer's :text-layer). `:text-layer` has no entity equivalent.
(def ^:private layer-table
  {:span         :span_layers
   :token        :token_layers
   :relation     :relation_layers
   :text-layer   :text_layers
   :token-layer  :token_layers
   :span-layer   :span_layers})

(defn- err! [msg data]
  (throw (ex-info msg (merge {:code 400 :query-error/stage :resolve} data))))

(defn- uuid-string?
  [s]
  (boolean (re-matches #"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" s)))

;; ---------------------------------------------------------------------------
;; Scope (ACL)
;; ---------------------------------------------------------------------------

(defn effective-scope
  "The set of project-id strings the user may query, intersected with the AST's
  requested `:scope` (`{:project-ids [ids]}`). Projects are identified by id only —
  there is no scope-by-name (project names are non-unique across a multi-tenant
  instance). Admins see all projects. Throws 400 if a requested scope resolves to
  nothing accessible."
  [db user-id requested]
  (let [admin? (usr/admin? (usr/get db user-id))
        accessible (set (map str (if admin? (prj/get-all-ids db) (prj/get-accessible-ids db user-id))))]
    (if (or (nil? requested) (empty? (:project-ids requested)))
      accessible
      ;; project ids are case-insensitive UUIDs; lower-case requested ids so an
      ;; uppercase one still intersects the (lowercased) accessible set
      (let [explicit (set (map (comp str/lower-case str) (:project-ids requested)))
            scoped (set/intersection accessible explicit)]
        (when (empty? scoped)
          (err! "None of the requested projects are accessible to you" {:requested requested}))
        scoped))))

;; ---------------------------------------------------------------------------
;; In-scope layer-id universe (per layer kind, within scope)
;; ---------------------------------------------------------------------------

(defn- in-scope-layer-ids
  "The set of layer-id strings of `kind` visible in `scope` (a set of project-id
  strings). Layers are identified by id only, so this is just the id universe a
  scalar reference is checked against — no name- or path-based lookup.

  Vocab layers are global (no project_id column); they are scoped by the
  `project_vocabs` grants of the in-scope projects, so a vocab layer is visible iff
  some in-scope project has been granted it."
  [db scope kind]
  (->> (when (seq scope)
         (if (= kind :vocab)
           (psc/q db {:select-distinct [:vl.id]
                      :from [[:vocab_layers :vl]]
                      :join [[:project_vocabs :pv] [:= :pv.vocab_layer_id :vl.id]]
                      :where [:in :pv.project_id (vec scope)]})
           (psc/q db {:select [:id]
                      :from [(layer-table kind)]
                      :where [:in :project_id (vec scope)]})))
       (map (comp str :id))
       set))

(defn- layer-clause-name
  "The layer-clause head name for `kind` (an entity kind like `:span` or a layer
  kind like `:text-layer`) — used only to phrase the 'bind it with a … clause' hint."
  [kind]
  (let [k (clojure.core/name kind)]
    (if (str/ends-with? k "-layer") k (str k "-layer"))))

(defn- resolve-ref
  "Resolve one scalar layer reference. Layers are identified by id ONLY: a reference
  must be a layer id (UUID) visible in the queried scope. Names and
  `Project/Layer` paths are not accepted — they are non-unique across a multi-tenant
  instance, and an id matches at most one layer (so there is no ambiguity). To select
  a layer by name, bind it with a layer-var clause instead. Returns a one-element
  vector of the (lower-cased) id string; throws 400 otherwise."
  [scope-ids kind ref]
  (let [s (str ref)]
    (cond
      (not (uuid-string? s))
      (err! (str (clojure.core/name kind) " layer reference " (pr-str ref)
                 " must be a layer id. Layers are identified by id only — to match by"
                 " name, bind the layer with a clause, e.g. [\"" (layer-clause-name kind)
                 "\" \"?l\" {\"name\" \"…\"}], then reference ?l.")
            {:layer ref :kind kind})
      ;; UUIDs are case-insensitive (RFC 4122); ids are stored/normalized lowercase,
      ;; so match an uppercase/mixed-case ref against the lowered form.
      (not (contains? scope-ids (str/lower-case s)))
      (err! (str "No " (clojure.core/name kind) " layer with id " (pr-str ref)
                 " is visible in the queried project scope")
            {:layer ref :kind kind})
      :else [(str/lower-case s)])))

;; ---------------------------------------------------------------------------
;; Resolve the whole query
;; ---------------------------------------------------------------------------

(defn resolve-query
  "Resolve scope + layer references for a validated AST. Returns the AST with
  `::scope` and per-entity-clause `::layer-ids` attached. The compiler consumes
  only the resolved AST and never reads layer names from the DB."
  [db user-id ast*]
  (let [scope (effective-scope db user-id (:scope ast*))
        _ (when (empty? scope)
            (err! "You have no accessible projects to query" {}))
        index-cache (atom {})
        get-index (fn [kind]
                    (or (@index-cache kind)
                        (let [ix (in-scope-layer-ids db scope kind)]
                          (swap! index-cache assoc kind ix)
                          ix)))
        layer-named? #{:span :token :relation :vocab}
        resolve-clause
        (fn resolve-clause [clause]
          (let [[head v cmap] clause]
            (cond
              ;; recurse into a :not's inner clauses so their layer refs resolve
              (= head :not) (into [:not] (map resolve-clause (rest clause)))
              ;; :related* [?a ?b {:layer L}] — resolve L against the RELATION index
              (= head :related*)
              (let [[_ a b cmap] clause
                    ids (resolve-ref (get-index :relation) :relation (:layer cmap))]
                [head a b (assoc cmap ::layer-ids (vec ids))])
              ;; a :layer that is a VARIABLE is a layer node (compiled as a join),
              ;; not a reference to resolve — leave it for the compiler
              (and (layer-named? head) (map? cmap) (contains? cmap :layer)
                   (not (symbol? (:layer cmap))))
              (let [ids (resolve-ref (get-index head) head (:layer cmap))]
                [head v (assoc cmap ::layer-ids (vec ids))])
              ;; a LAYER clause may carry structural slots referencing a parent layer
              ;; (token-layer's :text-layer / :parent-token-layer, span-layer's
              ;; :token-layer, relation-layer's :span-layer). A scalar ref is resolved
              ;; to an id against the PARENT kind's index; a var slot is left for the
              ;; compiler (a join). Mirrors the entity :layer branch above.
              (seq (ast/layer-slots-for head))
              [head v
               (reduce
                (fn [cm [slot parent-kind]]
                  (let [ref (get cm slot)]
                    (if (and (some? ref) (not (symbol? ref)))
                      (assoc-in cm [::slot-layer-ids slot]
                                (vec (resolve-ref (get-index parent-kind) parent-kind ref)))
                      cm)))
                cmap
                (ast/layer-slots-for head))]
              :else clause)))]
    (-> ast*
        (assoc :where (mapv resolve-clause (:where ast*)))
        (assoc ::scope scope))))
