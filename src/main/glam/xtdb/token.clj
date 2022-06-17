(ns glam.xtdb.token
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.span :as s]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:token/id
                :token/text
                :token/begin
                :token/end
                :token/layer])

(defn xt->pathom [doc]
  (when doc
    (-> doc
        (update :token/layer xutil/identize :token-layer/id)
        (update :token/text xutil/identize :text/id))))

(defn create* [{:token/keys [id] :as attrs}]
  (gxe/put* (xutil/create-record "token" id attrs attr-keys)))

(defn create [node attrs]
  (let [[_ {:token/keys [id]} :as put] (create* attrs)
        tx-status (gxe/submit! node [put])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:token/id id})))

(defn get-tokens
  [node layer-id doc-id]
  (let [tokens (->> (xt/q (xt/db node)
                          '{:find  [(pull ?tok [:token/id :token/text :token/begin :token/end :token/layer])]
                            :where [[?tok :token/layer ?tokl]
                                    [?tok :token/text ?txt]
                                    [?txt :text/document ?doc]]
                            :in    [[?tokl ?doc]]}
                          [layer-id doc-id])
                    (map first))]
    (if-not (seq tokens)
      []
      (if-let [{:text/keys [body]} (gxe/entity node (-> tokens first :token/text))]
        (map #(assoc % :token/value (subs body (:token/begin %) (:token/end %))) tokens)
        (do (log/error "Found tokens without a text!")
            (log/error (vec tokens))
            [])))))

;; Mutations --------------------------------------------------------------------------------
(defn- get-span-ids [node eid]
  (map first (xt/q (xt/db node)
                   '{:find  [?span]
                     :where [[?span :span/tokens ?tok]]
                     :in    [?tok]}
                   eid)))


(declare safe-create-internal**)
(gxe/deftx safe-create-internal [node {:token/keys [begin end text layer] :as token}]
  (let [other-tokens (map first (xt/q (xt/db node)
                                      '{:find  [(pull ?t [:token/begin :token/end])]
                                        :where [[?t :token/layer layer]
                                                [?t :token/text text]]
                                        :in    [[layer text]]}
                                      [layer text]))
        sorted-tokens (sort-by :token/begin (conj other-tokens token))
        {text-body :text/body} (gxe/entity node text)]

    (cond
      ;; Zero- or negative-width token
      (not (pos-int? (- end begin)))
      (throw (ex-info "Token has non-positive extent" {:token token}))

      ;; Bounds check: left
      (< begin 0)
      (throw (ex-info "Token has a negative start index" {:token token}))

      ;; Bounds check: right
      (> end (count text-body))
      (throw (ex-info "Token ends beyond the end of its associated text" {:token token
                                                                          :text-length (count text-body)
                                                                          :text text-body}))
      ;; Overlap with other tokens
      (some (fn [[{t1-end :token/end} {t2-begin :token/begin}]]
              (< t2-begin t1-end))
            (partition 2 1 sorted-tokens))
      (throw (ex-info "Token creation would result in overlap with another token" {:token token}))

      :else
      [(gxe/put* token)])))

;; Difference from above: we already have `other-tokens` here
(declare safe-create-internal2**)
(gxe/deftx safe-create-internal2 [node other-tokens {:token/keys [begin end text] :as token}]
  (let [sorted-tokens (sort-by :token/begin (conj other-tokens token))
        {text-body :text/body} (gxe/entity node text)]

    (cond
      ;; Zero- or negative-width token
      (not (pos-int? (- end begin)))
      (throw (ex-info "Token has non-positive extent" {:token token}))

      ;; Bounds check: left
      (< begin 0)
      (throw (ex-info "Token has a negative start index" {:token token}))

      ;; Bounds check: right
      (> end (count text-body))
      (throw (ex-info "Token ends beyond the end of its associated text" {:token token
                                                                          :text-length (count text-body)
                                                                          :text text-body}))
      ;; Overlap with other tokens
      (some (fn [[{t1-end :token/end} {t2-begin :token/begin}]]
              (< t2-begin t1-end))
            (partition 2 1 sorted-tokens))
      (throw (ex-info "Token creation would result in overlap with another token" {:token token}))

      :else
      [(gxe/put* token)])))

(defn safe-create [node token]
  (let [new-record (xutil/create-record "token" nil token (filterv #(not= % :token/id) attr-keys))
        success (safe-create-internal node new-record)]
    {:success success :id (:token/id new-record)}))

(gxe/deftx set-extent [node eid {:keys [new-begin new-end delta-begin delta-end]}]
  (let [{:token/keys [begin end text layer] :as token} (gxe/entity node eid)
        new-begin (or new-begin (and delta-begin (+ begin delta-begin)))
        new-end (or new-end (and delta-end (+ end delta-end)))
        new-token (cond-> token
                          (some? new-begin) (assoc :token/begin new-begin)
                          (some? new-end) (assoc :token/end new-end))
        other-tokens (map first (xt/q (xt/db node)
                                      '{:find  [(pull ?t2 [:token/begin :token/end])]
                                        :where [[?t2 :token/layer layer]
                                                [?t2 :token/text text]
                                                (not [?t2 :token/id ?t])]
                                        :in    [[?t layer text]]}
                                      [eid layer text]))
        sorted-tokens (sort-by :token/begin (conj other-tokens new-token))
        {text-body :text/body} (gxe/entity node text)]
    (cond
      ;; Token doesn't exist?
      (nil? token)
      (throw (ex-info "Token does not exist" {:token/id eid}))

      ;; Zero-width token
      (< (- (:token/end new-token) (:token/begin new-token)) 1)
      (throw (ex-info "Token has non-positive extent" {:old-token token
                                                       :new-token new-token}))

      ;; Bounds check: left
      (and (some? new-begin) (< new-begin 0))
      (throw (ex-info "Token has a negative start index" {:new-token new-token}))

      ;; Bounds check: right
      (and (some? new-end) (> new-end (count text-body)))
      (throw (ex-info "Token ends beyond the end of its associated text" {:new-token new-token
                                                                          :text-length (count text-body)
                                                                          :text text-body}))
      ;; Overlap with other tokens
      (some (fn [[{t1-end :token/end} {t2-begin :token/begin}]]
              (< t2-begin t1-end))
            (partition 2 1 sorted-tokens))
      (throw (ex-info "Change in extent would result in overlap with another token" {:new-token new-token}))

      :else
      [(gxe/put* new-token)])))

(defn shift-begin [node eid d] (set-extent node eid {:delta-begin d}))
(defn shift-end [node eid d] (set-extent node eid {:delta-end d}))
(defn set-begin [node eid n] (set-extent node eid {:new-begin n}))
(defn set-end [node eid n] (set-extent node eid {:new-end n}))

;; We don't follow the usual pattern of relying on child nodes' delete** functions here because
;; this would lead to children being included multiple times. Instead, we write a bespoke fn.
(defn delete** [node eid]
  (let [spans (get-span-ids node eid)]
    (into
      (reduce into (map #(s/remove-token** node % eid) spans))
      [(gxe/match* eid (gxe/entity node eid))
       (gxe/delete* eid)])))
(defn delete [node eid]
  (gxe/submit-tx-sync node (delete** node eid)))
