(ns plaid.xtdb.token
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
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
        {text-body :text/body text-layer-id :text/layer} (pxc/entity db text)
        {token-layers :text-layer/token-layers} (pxc/entity db text-layer-id)]
    (cond
      ;; ID is not already taken?
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Token" id) {:id id :code 409}))

      ;; Token layer exists?
      (nil? (:token-layer/id (pxc/entity db layer)))
      (throw (ex-info (pxc/err-msg-not-found "Token layer" layer) {:id layer :code 400}))

      ;; Text exists?
      (nil? (:text/id (pxc/entity db text)))
      (throw (ex-info (pxc/err-msg-not-found "Text" text) {:id text :code 400}))

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
      (throw (ex-info "Token has non-positive extent" {:token token}))

      ;; Bounds check: left
      (< begin 0)
      (throw (ex-info "Token has a negative start index" {:token token}))

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
       [::xt/put token]])))

(defn create [{:keys [node] :as xt-map} attrs]
  (pxc/submit-with-extras! node (create* xt-map attrs) #(-> % last last :xt/id)))

(defn set-extent [xt-map eid {:keys [new-begin new-end delta-begin delta-end]}]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        {:token/keys [begin end text layer] :as token} (pxc/entity db eid)
        new-begin (or new-begin (and delta-begin (+ begin delta-begin)))
        new-end (or new-end (and delta-end (+ end delta-end)))
        new-token (cond-> token
                          (some? new-begin) (assoc :token/begin new-begin)
                          (some? new-end) (assoc :token/end new-end))
        #_#_other-tokens (map first (xt/q db
                                          '{:find  [(pull ?t2 [:token/begin :token/end])]
                                            :where [[?t2 :token/layer layer]
                                                    [?t2 :token/text text]
                                                    (not [?t2 :token/id ?t])]
                                            :in    [[?t layer text]]}
                                          [eid layer text]))
        #_#_sorted-tokens (sort-by :token/begin (conj other-tokens new-token))
        {text-body :text/body} (pxc/entity db text)]
    (cond
      ;; Token doesn't exist?
      (nil? token)
      (throw (ex-info "Token does not exist" {:id eid}))

      ;; Non-negative extent?
      (neg? (- end begin))
      (throw (ex-info "Token has non-positive extent" {:old-token token
                                                       :new-token new-token}))

      ;; Bounds check: left
      (and (some? new-begin) (< new-begin 0))
      (throw (ex-info "Token has a negative start index" {:new-token new-token}))

      ;; Bounds check: right
      (and (some? new-end) (> new-end (count text-body)))
      (throw (ex-info "Token ends beyond the end of its associated text" {:new-token   new-token
                                                                          :text-length (count text-body)
                                                                          :text        text-body}))
      ;; Overlap with other tokens
      #_#_(some (fn [[{t1-end :token/end} {t2-begin :token/begin}]]
                  (< t2-begin t1-end))
                (partition 2 1 sorted-tokens))
              (throw (ex-info "Change in extent would result in overlap with another token" {:new-token new-token}))

      :else
      [[::xt/match eid token]
       [::xt/put new-token]])))

(defn shift-begin [xt-map eid d] (set-extent xt-map eid {:delta-begin d}))
(defn shift-end [xt-map eid d] (set-extent xt-map eid {:delta-end d}))
(defn set-begin [xt-map eid n] (set-extent xt-map eid {:new-begin n}))
(defn set-end [xt-map eid n] (set-extent xt-map eid {:new-end n}))

(defn set-precedence* [xt-map eid precedence]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        token (pxc/entity db eid)]
    (cond
      (nil? token)
      (throw (ex-info "Token does not exist" {:id eid}))

      (not (or (nil? precedence) (int? precedence)))
      (throw (ex-info (str "Precedence must either be not supplied or an integer.") {:code 400 :precedence precedence}))

      :else
      [[::xt/match eid token]
       [::xt/put (if (nil? precedence)
                   (dissoc token :token/precedence)
                   (assoc token :token/precedence precedence))]])))

(defn set-precedence [xt-map eid precedence]
  (pxc/submit! (:node xt-map) (set-precedence* xt-map eid precedence)))

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

(defn delete [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)]
    (pxc/submit! node (delete* xt-map eid))))