(ns plaid.sql.layer-constraints
  "The operations behind the layer constraint routes: declare a namespace's
  list on a layer, remove it, check a list against the stored data, and
  repair the stored data for a list. The rules themselves and their checks
  are in `plaid.sql.constraints.layer`."
  (:require [plaid.sql.common :as psc]
            [plaid.sql.constraints.layer :as lc]
            [plaid.sql.crud :as crud]
            [plaid.sql.operation :refer [submit-operation!]]))

(def ^:private tables {:token :token_layers :span :span_layers :relation :relation_layers})

(def ^:private nouns {:token "token layer" :span "span layer" :relation "relation layer"})

(defn- layer-row! [tx kind id]
  (or (psc/fetch-by-id tx (tables kind) id)
      (throw (ex-info (psc/err-msg-not-found (nouns kind) id) {:code 404 :id id}))))

(defn- project-of [db kind id]
  (:project_id (psc/fetch-by-id db (tables kind) id)))

(defn- changed?
  "Whether the compare-and-set a write asks for with `expected` fails: the
  namespace's stored list must equal it (nil meaning absent)."
  [stored ns check]
  (and (contains? check :expected)
       (not= (some-> (lc/normalize-list (:expected check)) seq vec)
             (some-> (get stored ns) seq vec))))

(defn- changed! [ns]
  (throw (ex-info (str "The " ns " constraints of this layer changed since they were read.")
                  {:code 409})))

(defn changed-result?
  "Whether an operation's result is the compare-and-set refusal, the only
  409 these operations give. The route adds `constraints-changed`."
  [result]
  (= 409 (:code result)))

(defn get-constraints
  "The layer's whole constraint map, namespace to list."
  [db kind id]
  (lc/parse-constraints (:constraints (psc/fetch-by-id db (tables kind) id))))

(defn set-constraints
  "Declare `constraints` as namespace `ns`'s list on the layer. The list is
  validated (400), compared with `expected` when `check` carries it (409),
  and checked against every stored row of the layer: any violation refuses
  it with 422 and nothing is stored. Returns the layer's whole map."
  [db kind id ns constraints check user-id]
  (submit-operation!
   [tx db {:type :layer/set-constraints
           :project (project-of db kind id)
           :document nil
           :description (str "Set " ns " constraints on " (nouns kind) " " id)
           :user user-id}]
   (lc/validate-namespace! ns)
   (let [row (layer-row! tx kind id)
         stored (lc/parse-constraints (:constraints row))
         cs (lc/validate-list tx kind row constraints)]
     (if (changed? stored ns check)
       (changed! ns)
       (let [layer (lc/layer-record-by-id tx kind id)
             vs (lc/check-layer tx layer ns cs)]
         (when (seq vs)
           (throw (lc/refusal tx vs)))
         (let [new-map (if (seq cs) (assoc stored ns cs) (dissoc stored ns))]
           (when (not= new-map stored)
             (crud/update-by-id! tx (tables kind) id {:constraints (psc/write-json new-map)}))
           new-map))))))

(defn delete-constraints
  "Remove namespace `ns`'s list from the layer. Checks nothing but `expected`."
  [db kind id ns check user-id]
  (submit-operation!
   [tx db {:type :layer/delete-constraints
           :project (project-of db kind id)
           :document nil
           :description (str "Remove " ns " constraints from " (nouns kind) " " id)
           :user user-id}]
   (lc/validate-namespace! ns)
   (let [row (layer-row! tx kind id)
         stored (lc/parse-constraints (:constraints row))]
     (cond
       (changed? stored ns check) (changed! ns)
       (contains? stored ns) (do (crud/update-by-id! tx (tables kind) id
                                                     {:constraints (psc/write-json (dissoc stored ns))})
                                 nil)
       :else nil))))

(defn check-constraints
  "The violations `constraints` would meet in the layer's stored data, as
  `{:violations :violation-count}`. Writes nothing."
  [db kind id constraints]
  (let [row (layer-row! db kind id)
        cs (lc/validate-list db kind row constraints)
        layer (lc/layer-record-by-id db kind id)
        vs (lc/check-layer db layer nil cs)]
    (if (seq vs)
      (select-keys (lc/violation-body db vs) [:violations :violation-count])
      {:violations [] :violation-count 0})))

(defn document-standing
  "Where `document` stands for a repair of the layer: `:unknown` when no
  document has that id, `:elsewhere` when it is in another project than the
  layer's, else nil."
  [db kind id document]
  (let [doc (psc/fetch-by-id db :documents document)]
    (cond
      (nil? doc) :unknown
      (not= (str (:project_id doc)) (str (project-of db kind id))) :elsewhere
      :else nil)))

(defn repair-constraints
  "Apply the remedies of the remediable types in `constraints` to the
  layer's stored data, one `layer/repair-constraints` operation per
  document, all in one transaction, or in `document` alone. A document
  another holds the lock on is left as it is. Answers what was repaired, the
  documents left for a lock, and the violations left (of the types with no
  remedy, and in the documents left)."
  [db kind id constraints user-id & {:keys [document]}]
  (let [out (atom nil)
        project (project-of db kind id)
        result (submit-operation!
                [tx db {:type :layer/repair-constraints
                        :project project
                        :document nil
                        :description (str "Repair layer rules on " (nouns kind) " " id)
                        :user user-id}]
                (let [row (layer-row! tx kind id)
                      cs (lc/validate-list tx kind row constraints)
                      layer (lc/layer-record-by-id tx kind id)
                      _ (when (and document
                                   (not= (str project)
                                         (str (:project_id (psc/fetch-by-id tx :documents document)))))
                          (throw (ex-info (str "Document " document " is not in this layer's project.")
                                          {:code 400})))
                      {:keys [repaired locked remaining]} (lc/repair-layer! tx user-id layer nil cs
                                                                            :document document)]
                  (reset! out {:repaired repaired
                               :locked locked
                               :violations (mapv lc/wire (take lc/max-listed remaining))
                               :violation-count (count remaining)})))]
    (if (:success result)
      (assoc result :extra @out)
      result)))
