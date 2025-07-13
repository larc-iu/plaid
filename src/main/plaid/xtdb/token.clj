(ns plaid.xtdb.token
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations!]]
            [plaid.xtdb.span :as s]
            [plaid.xtdb.metadata :as metadata]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get merge format]))

(def attr-keys [:token/id
                :token/text
                :token/begin
                :token/end
                :token/layer
                :token/precedence])

;; Queries ------------------------------------------------------------------------
(defn format [raw-record]
  (let [core-attrs (select-keys raw-record [:token/id :token/text :token/begin :token/end :token/layer :token/precedence])]
    (metadata/add-metadata-to-response core-attrs raw-record "token")))

(defn get
  "Get a token by ID, formatted for external consumption (API responses)."
  [db-like id]
  (when-let [token-entity (pxc/find-entity (pxc/->db db-like) {:token/id id})]
    (format token-entity)))

(defn project-id [db-like id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txtl :text-layer/token-layers ?tokl]
                      [?tok :token/layer ?tokl]]
              :in    [?tok]}
            id)
      first
      first))

(defn- project-id-from-layer [db-like layer-id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txtl :text-layer/token-layers ?tokl]]
              :in    [?tokl]}
            layer-id)
      first
      first))

(defn get-tokens
  "Provides a list of tokens, enriched with :token/value, a computed attribute indicating
  the the value of its substring."
  [db-like layer-id doc-id]
  (let [db (pxc/->db db-like)
        tokens (->> (xt/q db
                          '{:find  [(pull ?tok [:token/id :token/text :token/begin :token/end :token/layer])]
                            :where [[?tok :token/layer ?tokl]
                                    [?tok :token/text ?txt]
                                    [?txt :text/document ?doc]]
                            :in    [[?tokl ?doc]]}
                          [layer-id doc-id])
                    (map first))]
    (if-not (seq tokens)
      []
      (if-let [{:text/keys [body]} (pxc/entity db (-> tokens first :token/text))]
        (map #(assoc % :token/value (subs body (:token/begin %) (:token/end %))) tokens)))))

(defn get-span-ids [db-like eid]
  (map first (xt/q (pxc/->db db-like)
                   '{:find  [?span]
                     :where [[?span :span/tokens ?tok]]
                     :in    [?tok]}
                   eid)))

(defn get-doc-id-of-text
  [db text-id]
  (:text/document (pxc/entity db text-id)))

;; Mutations ----------------------------------------------------------------------
(defn- check-token-bounds!
  "Check if token bounds are valid relative to text body.
  Returns nil if valid, throws exception with appropriate error info otherwise."
  [begin end text-body]
  (cond
    ;; Numeric end and begin indices?
    (or (not (int? end)) (not (int? begin)))
    (throw (ex-info "Token end and begin must be numeric" {:end end :begin begin :code 400}))

    ;; Non-negative extent?
    (neg? (- end begin))
    (throw (ex-info "Token has non-positive extent" {:begin begin :end end :code 400}))

    ;; Bounds check: left
    (< begin 0)
    (throw (ex-info "Token has a negative start index" {:begin begin :code 400}))

    ;; Bounds check: right
    (> end (count text-body))
    (throw (ex-info "Token ends beyond the end of its associated text"
                    {:end end :text-length (count text-body) :code 400}))))

(defn- check-token-precedence!
  "Check if precedence value is valid (nil or integer).
  Returns nil if valid, throws exception otherwise."
  [precedence]
  (when-not (or (nil? precedence) (int? precedence))
    (throw (ex-info "Precedence must either be not supplied or an integer."
                    {:code 400 :precedence precedence}))))

(defn- check-tokens-consistency!
  "Check if all tokens belong to same text and layer.
  Used for bulk operations."
  [tokens-attrs]
  (when-not (= 1 (->> tokens-attrs (map :token/text) distinct count))
    (throw (ex-info "Tokens must all belong to the same text" {:code 400})))
  (when-not (= 1 (->> tokens-attrs (map :token/layer) distinct count))
    (throw (ex-info "Tokens must all belong to the same layer" {:code 400}))))

(defn schema-check!
  ([db token]
   (schema-check! db token false))
  ([db {:token/keys [id end begin text layer precedence] :as token} token-only?]
   (let [{text-body :text/body text-layer-id :text/layer :as text-record} (pxc/entity db text)
         {token-layers :text-layer/token-layers} (pxc/entity db text-layer-id)]
     ;; ID is not already taken?
     (when (some? (pxc/entity db id))
       (throw (ex-info (pxc/err-msg-already-exists "Token" id) {:id id :code 409})))

     ;; Token layer exists?
     (when (and (not token-only?) (nil? (:token-layer/id (pxc/entity db layer))))
       (throw (ex-info (pxc/err-msg-not-found "Token layer" layer) {:id layer :code 400})))

     ;; Text exists?
     (when (and (not token-only?) (nil? (:text/id text-record)))
       (throw (ex-info (pxc/err-msg-not-found "Text" text) {:id text :code 400})))

     ;; Text layer of the text is linked to the token layer
     (when (and (not token-only?) (not ((set token-layers) layer)))
       (throw (ex-info (str "Text layer " text-layer-id " is not linked to token layer " layer ".")
                       {:text-layer-id text-layer-id :token-layer-id layer})))

     ;; Validate bounds
     (check-token-bounds! begin end text-body)

     ;; Validate precedence
     (check-token-precedence! precedence))))

(defn- token-attr?
  "Check if an attribute key belongs to token namespace (including metadata attributes)."
  [k]
  (= "token" (namespace k)))

(defn create*
  [xt-map attrs]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        token-attrs (filter (fn [[k v]] (token-attr? k)) attrs)
        {:token/keys [text layer] :as token} (clojure.core/merge (pxc/new-record "token")
                                                                 {:token/-document (get-doc-id-of-text db (:token/text attrs))}
                                                                 (into {} token-attrs))]
    (schema-check! db token)
    [[::xt/match layer (pxc/entity db layer)]
     [::xt/match text (pxc/entity db text)]
     [::xt/match (:xt/id token) nil]
     [::xt/put token]]))

(defn create-operation
  "Build an operation for creating a token with metadata"
  [xt-map attrs metadata]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        {:token/keys [layer text begin end]} attrs
        project-id (project-id-from-layer db layer)
        doc-id (get-doc-id-of-text db text)
        ;; Expand metadata into token attributes
        metadata-attrs (metadata/transform-metadata-for-storage metadata "token")
        attrs-with-metadata (clojure.core/merge attrs metadata-attrs)
        tx-ops (create* xt-map attrs-with-metadata)]
    (op/make-operation
      {:type        :token/create
       :project     project-id
       :document    doc-id
       :description (str "Create token " begin "-" end " in layer " layer
                         (when metadata (str " with " (count metadata) " metadata keys")))
       :tx-ops      tx-ops})))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata]
   (submit-operations! xt-map [(create-operation xt-map attrs metadata)] user-id #(-> % last last :xt/id))))

(defn- set-extent [{:keys [node db] :as xt-map} eid {new-begin :token/begin new-end :token/end}]
  (let [{:token/keys [begin end text layer] :as token} (pxc/entity db eid)
        new-begin (or new-begin begin)
        new-end (or new-end end)
        {text-body :text/body :as text-record} (pxc/entity db text)]
    ;; Token doesn't exist?
    (when (nil? token)
      (throw (ex-info "Token does not exist" {:id eid :code 404})))

    ;; Validate bounds
    (check-token-bounds! new-begin new-end text-body)

    ;; Return the new extent
    {:token/begin new-begin :token/end new-end}))

(defn- set-precedence [{:keys [node db] :as xt-map} eid precedence]
  (let [token (pxc/entity db eid)]
    ;; Token doesn't exist?
    (when (nil? token)
      (throw (ex-info "Token does not exist" {:id eid :code 404})))

    ;; Validate precedence
    (check-token-precedence! precedence)

    ;; Return precedence update (or empty map if nil)
    (if (nil? precedence)
      {}
      {:token/precedence precedence})))

(defn merge* [xt-map eid attrs]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        {text-id :token/text} (pxc/entity db eid)
        extent-attrs (set-extent xt-map eid (select-keys attrs [:token/begin :token/end]))
        precedence-attrs (set-precedence xt-map eid (:token/precedence (select-keys attrs [:token/precedence])))
        base (into [[::xt/match text-id (pxc/entity db text-id)]]
                   (pxc/merge* xt-map :token/id eid (clojure.core/merge extent-attrs precedence-attrs)))]
    (if (and (contains? attrs :token/precedence) (nil? (:token/precedence attrs)))
      (update-in base [2 1] dissoc :token/precedence)
      base)))

(defn merge-operation
  "Build an operation for updating a token"
  [xt-map eid attrs]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        token (pxc/entity db eid)
        project-id (project-id db eid)
        doc-id (get-doc-id-of-text db (:token/text token))
        tx-ops (merge* xt-map eid attrs)
        changes (cond-> []
                        (contains? attrs :token/begin) (conj "start")
                        (contains? attrs :token/end) (conj "end")
                        (contains? attrs :token/precedence) (conj "precedence"))]
    (op/make-operation
      {:type        :token/update
       :project     project-id
       :document    doc-id
       :description (str "Update " (clojure.string/join ", " changes) " of token " eid)
       :tx-ops      tx-ops})))

(defn merge [xt-map eid attrs user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid attrs)] user-id))

(defn set-metadata [xt-map eid metadata user-id]
  (letfn [(project-id-fn [db eid] (project-id db eid))
          (document-id-fn [db token] (get-doc-id-of-text db (:token/text token)))]
    (metadata/set-metadata xt-map eid metadata user-id "token" project-id-fn document-id-fn)))

(defn delete-metadata [xt-map eid user-id]
  (letfn [(project-id-fn [db eid] (project-id db eid))
          (document-id-fn [db token] (get-doc-id-of-text db (:token/text token)))]
    (metadata/delete-metadata xt-map eid user-id "token" project-id-fn document-id-fn)))

(defn bulk-create*
  "Create multiple tokens in a single transaction"
  [xt-map tokens-attrs]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        layer (-> tokens-attrs first :token/layer)
        layer-entity (pxc/entity db layer)
        text (-> tokens-attrs first :token/text)
        text-entity (pxc/entity db text)
        tokens-attrs (for [attrs tokens-attrs]
                       (if-let [metadata (:metadata attrs)]
                         (-> attrs
                             (dissoc :metadata)
                             (clojure.core/merge (metadata/transform-metadata-for-storage metadata "token")))
                         (dissoc attrs :metadata)))]
    (check-tokens-consistency! tokens-attrs)

    ;; If validation passes, create transaction operations
    (vec
      (concat
        [[::xt/match layer layer-entity]
         [::xt/match text text-entity]]
        (reduce
          (fn [tx-ops attrs]
            (let [token-attrs (filter (fn [[k v]] (token-attr? k)) attrs)
                  {:token/keys [id] :as token} (clojure.core/merge (pxc/new-record "token")
                                                                   {:token/-document (get-doc-id-of-text db (:token/text attrs))}
                                                                   (into {} token-attrs))
                  _ (schema-check! db token (not (empty? tx-ops)))]
              (into tx-ops [[::xt/match id nil]
                            [::xt/put token]])))
          []
          tokens-attrs)))))

(defn bulk-create-operation
  "Build an operation for creating multiple tokens"
  [xt-map tokens-attrs]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        ;; Get project and document info from first token (assuming all in same project/doc)
        first-attrs (first tokens-attrs)
        {:token/keys [layer text]} first-attrs
        project-id (project-id-from-layer db layer)
        doc-id (get-doc-id-of-text db text)
        tx-ops (bulk-create* xt-map tokens-attrs)]
    (op/make-operation
      {:type        :token/bulk-create
       :project     project-id
       :document    doc-id
       :description (str "Bulk create " (count tokens-attrs) " tokens in layer " layer)
       :tx-ops      tx-ops})))

(defn bulk-create
  "Create multiple tokens in a single operation"
  [xt-map tokens-attrs user-id]
  (submit-operations!
    xt-map
    [(bulk-create-operation xt-map tokens-attrs)]
    user-id
    (fn [tx]
      (vec (for [[op-type record] tx
                 :when (and (= op-type ::xt/put)
                            (:token/id record))]
             (:token/id record))))))

(defn delete*
  [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        spans (get-span-ids db eid)
        ;; Delete all vocab-links containing this token
        vocab-link-ids (map first (xt/q db
                                        '{:find [?vm]
                                          :where [[?vm :vocab-link/tokens ?tok]]
                                          :in [?tok]}
                                        eid))
        vocab-link-deletions (reduce into (mapv (fn [vocab-link-id]
                                                  [[::xt/match vocab-link-id (pxc/entity db vocab-link-id)]
                                                   [::xt/delete vocab-link-id]])
                                                vocab-link-ids))]

    (when-not (:token/id (pxc/entity db eid))
      (throw (ex-info (pxc/err-msg-not-found "Token" eid) {:code 404 :id eid})))

    (reduce into
            [vocab-link-deletions
             (mapcat #(s/remove-token* xt-map % eid) spans)
             [[::xt/match eid (pxc/entity db eid)]
              [::xt/delete eid]]])))

(defn delete-operation
  "Build an operation for deleting a token"
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        token (pxc/entity db eid)
        spans (get-span-ids db eid)
        project-id (project-id db eid)
        doc-id (when token (get-doc-id-of-text db (:token/text token)))
        tx-ops (delete* xt-map eid)]
    (op/make-operation
      {:type        :token/delete
       :project     project-id
       :document    doc-id
       :description (str "Delete token " eid " from " (count spans) " spans")
       :tx-ops      tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

(defn multi-delete*
  "We need a more advanced function for processing multiple deletes of a token because using delete* multiple
  times in a transaction could lead to conflicting matches and puts."
  [xt-map eids]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        tokens-attrs (mapv #(pxc/entity db %) eids)
        _ (check-tokens-consistency! tokens-attrs)
        eids-set (set eids)
        ;; Find all spans that contain any of the tokens being deleted
        spans (->> (xt/q db
                         '{:find  [?s]
                           :where [[?s :span/tokens ?t]
                                   [?t :token/id ?tid]]
                           :in    [[?tid ...]]}
                         eids)
                   (map first)
                   (distinct)
                   (map #(pxc/entity db %)))
        ;; Process each span to determine if it should be updated or deleted
        span-updates (for [span spans
                           :let [remaining-tokens (remove eids-set (:span/tokens span))]]
                       {:span             span
                        :remaining-tokens remaining-tokens
                        :should-delete?   (empty? remaining-tokens)})
        ;; Separate spans to be deleted from those to be updated
        spans-to-delete (filter :should-delete? span-updates)
        spans-to-update (remove :should-delete? span-updates)
        ;; Find all relations that need to be deleted (those referencing deleted spans)
        span-ids-to-delete (set (map #(get-in % [:span :xt/id]) spans-to-delete))
        relations-to-delete (when (seq span-ids-to-delete)
                              (->> (xt/q db {:find  ['?r]
                                             :where '[(or [?r :relation/source ?s]
                                                          [?r :relation/target ?s])]
                                             :in    ['[?s ...]]}
                                         (vec span-ids-to-delete))
                                   (map first)
                                   (distinct)
                                   (map #(pxc/entity db %))))
        ;; Delete all vocab-links for these tokens
        vocab-link-ids (mapcat (fn [eid]
                                 (map first (xt/q db
                                                  '{:find [?vm]
                                                    :where [[?vm :vocab-link/tokens ?tok]]
                                                    :in [?tok]}
                                                  eid)))
                               eids)
        vocab-link-deletions (reduce into [] (mapv (fn [vocab-link-id]
                                                     [[::xt/match vocab-link-id (pxc/entity db vocab-link-id)]
                                                      [::xt/delete vocab-link-id]])
                                                   (distinct vocab-link-ids)))]
    (vec
      (concat
        ;; Delete vocab-links first
        vocab-link-deletions
        ;; Match and delete all tokens
        (for [eid eids
              :let [token (pxc/entity db eid)]
              :when token
              op [[::xt/match eid token]
                  [::xt/delete eid]]]
          op)
        ;; Update spans that still have tokens
        (for [{:keys [span remaining-tokens]} spans-to-update
              op [[::xt/match (:xt/id span) span]
                  [::xt/put (assoc span :span/tokens remaining-tokens)]]]
          op)
        ;; Delete spans with no remaining tokens
        (for [{:keys [span]} spans-to-delete
              op [[::xt/match (:xt/id span) span]
                  [::xt/delete (:xt/id span)]]]
          op)
        ;; Delete relations that reference deleted spans
        (for [relation relations-to-delete
              op [[::xt/match (:xt/id relation) relation]
                  [::xt/delete (:xt/id relation)]]]
          op)))))

(defn bulk-delete-operation
  "Build an operation for deleting multiple tokens"
  [xt-map eids]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        ;; Get project info from first token
        first-token (pxc/entity db (first eids))
        project-id (when first-token (project-id db (first eids)))
        doc-id (when first-token (get-doc-id-of-text db (:token/text first-token)))
        tx-ops (multi-delete* xt-map eids)]
    (op/make-operation
      {:type        :token/bulk-delete
       :project     project-id
       :document    doc-id
       :description (str "Bulk delete " (count eids) " tokens")
       :tx-ops      tx-ops})))

(defn bulk-delete
  "Delete multiple tokens in a single operation"
  [xt-map eids user-id]
  (submit-operations! xt-map [(bulk-delete-operation xt-map eids)] user-id))