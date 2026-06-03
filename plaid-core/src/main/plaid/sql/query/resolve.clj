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

;; Entity-clause kind -> its layer table.
(def ^:private layer-table
  {:span     :span_layers
   :token    :token_layers
   :relation :relation_layers})

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
  requested `:scope` (`{:projects [names] :project-ids [ids]}`). Admins see all
  projects. Throws 400 if a requested scope resolves to nothing accessible."
  [db user-id requested]
  (let [admin? (usr/admin? (usr/get db user-id))
        accessible (set (map str (if admin? (prj/get-all-ids db) (prj/get-accessible-ids db user-id))))]
    (if (or (nil? requested) (and (empty? (:projects requested)) (empty? (:project-ids requested))))
      accessible
      (let [{:keys [projects project-ids]} requested
            named (when (seq projects)
                    (->> (psc/q db {:select [:id :name] :from [:projects]
                                    :where [:in :name (vec projects)]})
                         (map (comp str :id)) set))
            explicit (set (map str project-ids))
            requested-set (set/union (or named #{}) explicit)
            scoped (set/intersection accessible requested-set)]
        (when (empty? scoped)
          (err! "None of the requested projects are accessible to you" {:requested requested}))
        scoped))))

;; ---------------------------------------------------------------------------
;; Layer-alias index (per layer kind, within scope)
;; ---------------------------------------------------------------------------

(defn- build-index
  "Build a lookup index for one layer kind over the in-scope projects.
  Returns {:by-id #{id} :by-name {name [ids]} :by-alias {alias [ids]}
           :by-path {\"Project/Layer\" [ids]}}.

  Vocab layers are global (no project_id column); they are scoped by the
  `project_vocabs` grants of the in-scope projects, so a vocab layer is
  visible iff some in-scope project has been granted it."
  [db scope kind proj-id->name]
  (let [rows (when (seq scope)
               (if (= kind :vocab)
                 (psc/q db {:select-distinct [:vl.id :vl.name :vl.config [:pv.project_id :project_id]]
                            :from [[:vocab_layers :vl]]
                            :join [[:project_vocabs :pv] [:= :pv.vocab_layer_id :vl.id]]
                            :where [:in :pv.project_id (vec scope)]})
                 (psc/q db {:select [:id :name :project_id :config]
                            :from [(layer-table kind)]
                            :where [:in :project_id (vec scope)]})))]
    (reduce
     (fn [ix {:keys [id name project_id config]}]
       (let [id (str id)
             alias (get (psc/parse-config config) "plaid/alias")
             pname (proj-id->name (str project_id))
             path (when pname (str pname "/" name))]
         (cond-> ix
           true        (update :by-id conj id)
           name        (update-in [:by-name name] (fnil conj []) id)
           alias       (update-in [:by-alias alias] (fnil conj []) id)
           path        (update-in [:by-path path] (fnil conj []) id))))
     {:by-id #{} :by-name {} :by-alias {} :by-path {}}
     rows)))

(defn- resolve-ref
  "Resolve one scalar layer reference against a kind's index, in order:
  path (\"Project/Layer\") -> uuid (by id) -> bare string (alias, then name).
  A scalar reference must identify EXACTLY ONE layer — names, paths, and aliases
  are all non-unique (two projects can share a name, an alias is shared by
  convention), so a reference matching several layers is an *ambiguous* 400, not
  a silent `IN (…)` fan-out (which would be an implicit OR over layers). Returns
  a one-element vector of layer-id strings. To match several layers on purpose,
  list their ids or (future) bind a layer variable."
  [index kind ref]
  (let [s (str ref)
        ids (distinct
             (cond
               (str/includes? s "/") (get-in index [:by-path s])
               (uuid-string? s)      (when (contains? (:by-id index) s) [s])
               :else                 (concat (get-in index [:by-alias s])
                                             (get-in index [:by-name s]))))]
    (cond
      (empty? ids)
      (err! (str "No " (clojure.core/name kind) " layer matching " (pr-str ref)
                 " is visible in the queried project scope")
            {:layer ref :kind kind})
      (> (count ids) 1)
      (err! (str (clojure.core/name kind) " layer reference " (pr-str ref) " is ambiguous — it matches "
                 (count ids) " layers in your scope. Qualify it with a layer id (or narrow :scope to one project).")
            {:layer ref :kind kind :matches (vec ids)})
      :else (vec ids))))

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
        proj-id->name (into {} (map (juxt (comp str :id) :name))
                            (psc/q db {:select [:id :name] :from [:projects]
                                       :where [:in :id (vec scope)]}))
        index-cache (atom {})
        get-index (fn [kind]
                    (or (@index-cache kind)
                        (let [ix (build-index db scope kind proj-id->name)]
                          (swap! index-cache assoc kind ix)
                          ix)))
        layer-named? #{:span :token :relation :vocab}
        resolve-clause
        (fn resolve-clause [clause]
          (let [[head v cmap] clause]
            (cond
              ;; recurse into a :not's inner clauses so their layer refs resolve
              (= head :not) (into [:not] (map resolve-clause (rest clause)))
              ;; a :layer that is a VARIABLE is a layer node (compiled as a join),
              ;; not a reference to resolve — leave it for the compiler
              (and (layer-named? head) (map? cmap) (contains? cmap :layer)
                   (not (symbol? (:layer cmap))))
              (let [ids (resolve-ref (get-index head) head (:layer cmap))]
                [head v (assoc cmap ::layer-ids (vec ids))])
              :else clause)))]
    (-> ast*
        (assoc :where (mapv resolve-clause (:where ast*)))
        (assoc ::scope scope))))
