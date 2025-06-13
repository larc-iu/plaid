(ns plaid.xtdb.token
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations! submit-operations-with-extras!]]
            [plaid.xtdb.span :as s]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:token/id
                :token/text
                :token/begin
                :token/end
                :token/layer
                :token/precedence])

;; Queries ------------------------------------------------------------------------
(defn get
  [db-like id]
  (pxc/find-entity (pxc/->db db-like) {:token/id id}))

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

;; Mutations --------------------------------------------------------------------------------
(defn create*
  [xt-map attrs]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        {:token/keys [id end begin text layer precedence] :as token} (clojure.core/merge (pxc/new-record "token")
                                                                                         (select-keys attrs attr-keys))
        #_#_other-tokens (map first (xt/q db
                                          '{:find  [(pull ?t [:token/begin :token/end])]
                                            :where [[?t :token/layer layer]
                                                    [?t :token/text text]]
                                            :in    [[layer text]]}
                                          [layer text]))
        ;; sorted-tokens (sort-by :token/begin (conj other-tokens token))
        {text-body :text/body text-layer-id :text/layer :as text} (pxc/entity db text)
        {token-layers :text-layer/token-layers} (pxc/entity db text-layer-id)]
    (cond
      ;; ID is not already taken?
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Token" id) {:id id :code 409}))

      ;; Token layer exists?
      (nil? (:token-layer/id (pxc/entity db layer)))
      (throw (ex-info (pxc/err-msg-not-found "Token layer" layer) {:id layer :code 400}))

      ;; Text exists?
      (nil? (:text/id text))
      (throw (ex-info (pxc/err-msg-not-found "Text" text) {:id (:text/id text) :code 400}))

      ;; Text layer of the text is linked to the token layer
      (not ((set token-layers) layer))
      (throw (ex-info (str "Text layer " text-layer-id " is not linked to token layer " layer ".")
                      {:text-layer-id text-layer-id :token-layer-id layer}))

      ;; Numeric end and begin indices?
      (or (not (int? end)) (not (int? begin)))
      (throw (ex-info (str "Token end and begin must be numeric") {:end end :begin begin :code 400}))

      ;; Precedence either nil or int?
      (not (or (nil? precedence) (int? precedence)))
      (throw (ex-info (str "Precedence must either be not supplied or an integer.") {:code 400 :precedence precedence}))

      ;; Non-negative extent?
      (neg? (- end begin))
      (throw (ex-info "Token has non-positive extent" {:token token :code 400}))

      ;; Bounds check: left
      (< begin 0)
      (throw (ex-info "Token has a negative start index" {:token token :code 400}))

      ;; Bounds check: right
      (> end (count text-body))
      (throw (ex-info "Token ends beyond the end of its associated text" {:token       token
                                                                          :text-length (count text-body)
                                                                          :text        text-body}))
      ;; Overlap with other tokens
      ;; (some (fn [[{t1-end :token/end} {t2-begin :token/begin}]]
      ;;         (< t2-begin t1-end))
      ;;       (partition 2 1 sorted-tokens))
      ;; (throw (ex-info "Token creation would result in overlap with another token" {:token token}))

      :else
      [[::xt/match (:xt/id token) nil]
       [::xt/match layer (pxc/entity db layer)]
       [::xt/match (:xt/id text) text]
       [::xt/put token]])))

(defn get-doc-id-of-text
  [db text-id]
  (:text/document (pxc/entity db text-id)))

(defn create-operation
  "Build an operation for creating a token"
  [xt-map attrs]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        {:token/keys [layer text begin end]} attrs
        project-id (project-id db layer)
        doc-id (get-doc-id-of-text db text)
        tx-ops (create* xt-map attrs)]
    (op/make-operation
     {:type        :token/create
      :project-id  project-id
      :document-id doc-id
      :description (str "Create token " begin "-" end " in layer " layer)
      :tx-ops      tx-ops})))

(defn create [xt-map attrs user-id]
  (submit-operations-with-extras! xt-map [(create-operation xt-map attrs)] user-id #(-> % last last :xt/id)))

(defn- set-extent [{:keys [node db] :as xt-map} eid {new-begin :token/begin new-end :token/end}]
  (let [{:token/keys [begin end text layer] :as token} (pxc/entity db eid)
        new-begin (or new-begin begin)
        new-end (or new-end end)
        new-token (-> token
                      (assoc :token/begin new-begin)
                      (assoc :token/end new-end))
        #_#_other-tokens (map first (xt/q db
                                          '{:find  [(pull ?t2 [:token/begin :token/end])]
                                            :where [[?t2 :token/layer layer]
                                                    [?t2 :token/text text]
                                                    (not [?t2 :token/id ?t])]
                                            :in    [[?t layer text]]}
                                          [eid layer text]))
        #_#_sorted-tokens (sort-by :token/begin (conj other-tokens new-token))
        {text-body :text/body :as text-record} (pxc/entity db text)]
    (cond
      ;; Token doesn't exist?
      (nil? token)
      (throw (ex-info "Token does not exist" {:id eid :code 404}))

      ;; Non-negative extent?
      (neg? (- new-end new-begin))
      (throw (ex-info "Token has non-positive extent" {:old-token token
                                                       :new-token new-token
                                                       :code 400}))

      ;; Bounds check: left
      (and (some? new-begin) (< new-begin 0))
      (throw (ex-info "Token has a negative start index" {:new-token new-token :code 400}))

      ;; Bounds check: right
      (and (some? new-end) (> new-end (count text-body)))
      (throw (ex-info "Token ends beyond the end of its associated text" {:new-token   new-token
                                                                          :text-length (count text-body)
                                                                          :text        text-body
                                                                          :code 400}))
      ;; Overlap with other tokens
      #_#_(some (fn [[{t1-end :token/end} {t2-begin :token/begin}]]
                  (< t2-begin t1-end))
                (partition 2 1 sorted-tokens))
              (throw (ex-info "Change in extent would result in overlap with another token" {:new-token new-token}))

      :else
      (select-keys new-token [:token/begin :token/end]))))

(defn- set-precedence [{:keys [node db] :as xt-map} eid precedence]
  (let [token (pxc/entity db eid)]
    (cond
      (nil? token)
      (throw (ex-info "Token does not exist" {:id eid :code 404}))

      (not (or (nil? precedence) (int? precedence)))
      (throw (ex-info (str "Precedence must either be not supplied or an integer.") {:code 400 :precedence precedence}))

      :else
      (if (nil? precedence)
        {}
        {:token/precedence precedence}))))

(defn merge* [xt-map eid attrs]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        {text-id :token/text} (pxc/entity db eid)
        extent-attrs (set-extent xt-map eid (select-keys attrs [:token/begin :token/end]))
        precedence-attrs (set-precedence xt-map eid (:token/precedence (select-keys attrs [:token/precedence])))
        base (into [[::xt/match text-id (pxc/entity db text-id)]]
                   (pxc/merge* xt-map eid (clojure.core/merge extent-attrs precedence-attrs)))]
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
      :project-id  project-id
      :document-id doc-id
      :description (str "Update " (clojure.string/join ", " changes) " of token " eid)
      :tx-ops      tx-ops})))

(defn merge [xt-map eid attrs user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid attrs)] user-id))

(defn delete*
  [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        spans (get-span-ids db eid)]

    (when-not (:token/id (pxc/entity db eid))
      (throw (ex-info (pxc/err-msg-not-found "Token" eid) {:code 404 :id eid})))

    (into
      (reduce into (map #(s/remove-token* xt-map % eid) spans))
      [[::xt/match eid (pxc/entity db eid)]
       [::xt/delete eid]])))

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
      :project-id  project-id
      :document-id doc-id
      :description (str "Delete token " eid " from " (count spans) " spans")
      :tx-ops      tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))