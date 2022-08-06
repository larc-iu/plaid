(ns glam.models.token-layer
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.mutations :as m]
            #?(:clj [xtdb.api :as xt])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.models.common :as mc :refer [server-message server-error]])
            #?(:clj [glam.xtdb.document :as doc])
            #?(:clj [glam.xtdb.text-layer :as txtl])
            #?(:clj [glam.xtdb.text :as txt])
            #?(:clj [glam.xtdb.token-layer :as tokl])
            #?(:clj [glam.xtdb.easy :as gxe])
            #?(:clj [glam.xtdb.token :as tok])
            #?(:clj [glam.xtdb.span :as span])
            #?(:clj [glam.xtdb.span-layer :as sl])
            [glam.algos.text :as ta]))

(def token-layer-keys [:token-layer/name :token-layer/span-layers])

(defn valid-name [name] (and (string? name) (<= 1 (count name) 80)))
(defn- field-valid [field v]
  (case field
    :token-layer/name (valid-name v)))

(defn token-layer-valid [form field]
  (let [v (get form field)]
    (field-valid field v)))

(defn record-valid? [record]
  (every? (fn [[k v]]
            (field-valid k v)) (log/spy record)))

(def validator (fs/make-validator token-layer-valid))


(defn get-token-span-layers [layer-ids]
  (->> layer-ids (filter #(= (second %) :token)) keys))
(defn get-sentence-span-layers [layer-ids]
  (->> layer-ids (filter #(= (second %) :sentence)) keys))

(defn reshape-into-token-grid
  "Given a token layer's data tree with :token-layer/spans, returns the sequence of tokens
  where each token has been enriched with a :token/spans attribute containing a list of 2-tuples,
  where for each span in the layer that is linked to the token and is configured as a
  token-level span layer, the first item is the span layer's ID, and the second item is a
  sequence of all spans on that layer that were linkde to this token. Example:

      (reshape-into-token-grid tl)
      =>
      ({:token/id :tok2,
        :token/value \"sentence\",
        :token/begin 5,
        :token/end 13,
        :token/spans (#:span{:id :s2, :value \"NN\", :tokens [#:token{:id :tok2}], :layer :sl1})
       ...)
  "
  [tokens spans]
  (for [{token-id :token/id :as token} tokens]
    (assoc token
      :token/spans
      (let [filtered-spans (filterv (fn [{:span/keys [tokens]}]
                                      (some #(= % token-id) tokens))
                                    spans)]
        filtered-spans))))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-token-layer [{:keys [node]} {:token-layer/keys [id]}]
     {::pc/input     #{:token-layer/id}
      ::pc/output    [:token-layer/id :token-layer/name :token-layer/span-layers]
      ::pc/transform (ma/readable-required :token-layer/id)}
     (tokl/get node id)))

#?(:clj
   (pc/defresolver get-tokens [{:keys [node] :as env} {:token-layer/keys [id]}]
     {::pc/input     #{:token-layer/id}
      ::pc/output    [{:token-layer/tokens [:token/id :token/text :token/begin :token/end :token/layer :token/value]}]
      ::pc/transform (ma/readable-required :token-layer/id)}
     (when-let [[_ doc-id] (mc/try-get-document-ident env)]
       (when-let [tokens (mapv (fn [token]
                                 (-> token
                                     (update :token/text (fn [id] {:text/id id}))
                                     (update :token/layer (fn [id] {:token-layer/id id}))))
                               (tok/get-tokens node id doc-id))]
         {:token-layer/tokens tokens}))))

#?(:clj
   (pc/defresolver lorge-get-tokens [{:keys [node] :as env} {:token-layer/keys [id]}]
     {::pc/input     #{:token-layer/id}
      ::pc/output    [:token-layer/name
                      {:token-layer/tokens [:token/id :token/text :token/begin :token/end :token/layer :token/value]}
                      {:token-layer/span-layers
                       [:span-layer/id :span-layer/name
                        {:span-layer/spans [:span/id :span/value :span/layer]}]}]
      ::pc/transform (ma/readable-required :token-layer/id)}
     (when-let [[_ doc-id] (mc/try-get-document-ident env)]
       (let [tokens (mapv (fn [token]
                            (-> token
                                (update :token/text (fn [id] {:text/id id}))
                                (update :token/layer (fn [id] {:token-layer/id id}))))
                          (tok/get-tokens node id doc-id))
             sl-ids (set (:token-layer/span-layers (gxe/entity node id)))
             spans (->> (xt/q (xt/db node)
                              '{:find  [(pull ?s [:span/layer :span/id :span/value])]
                                :where [[?tok :token/text ?txt]
                                        [?txt :text/document ?doc]
                                        [?s :span/tokens ?tok]
                                        [?s :span/layer ?sl]]
                                :in    [[?sl ?doc]]}
                              [sl-ids doc-id])
                        (map first))
             spans-by-id (group-by :span/layer spans)
             sls (map #(gxe/entity node %) sl-ids)
             span-layers (for [sl sls]
                           (assoc sl :span-layer/spans
                                     (mapv (fn [s]
                                             (-> s (update :span/layer (fn [id] {:span-layer/id id}))))
                                           (spans-by-id (:span-layer/id sl)))))]
         (merge {:token-layer/name (:token-layer/name (gxe/entity node id))}
                {:token-layer/tokens      tokens
                 :token-layer/span-layers span-layers})))))

#?(:clj
   (pc/defresolver lorge-get-columnar-tokens [{:keys [node] :as env} {:token-layer/keys [id]}]
     {::pc/input     #{:token-layer/id}
      ::pc/output    [:token-layer/name
                      {:token-layer/columnar-tokens
                       [:token/id :token/begin :token/end :token/layer :token/value :token/line
                        {:token/spans [:span/id :span/value :span/layer :span/tokens]}]}
                      {:token-layer/sentence-level-spans [:span/id :span/layer :span/value :span/tokens]}
                      {:token-layer/token-span-layers [:span-layer/id :span-layer/name]}
                      {:token-layer/sentence-span-layers [:span-layer/id :span-layer/name]}]
      ::pc/transform (ma/readable-required :token-layer/id)}
     (when-let [[_ doc-id] (mc/try-get-document-ident env)]
       (let [config (get-in (ffirst (xt/q (xt/db node) '{:find  [?pc]
                                                         :where [[?doc :document/project ?prj]
                                                                 [?prj :project/config ?pc]]
                                                         :in    [?doc]}
                                          doc-id))
                            [:editors :interlinear])
             text (ffirst (xt/q (xt/db node)
                                '{:find  [(pull ?txt [:text/id :text/body])]
                                  :where [[?txt :text/document ?doc]]
                                  :in    [?doc]}
                                doc-id))
             tokens (mapv (fn [token]
                            (-> token (update :token/layer (fn [id] {:token-layer/id id}))))
                          (tok/get-tokens node id doc-id))
             token-sl-ids (get-token-span-layers (:span-layer-scopes config))

             token-span-layers (mapv #(sl/get node %) token-sl-ids)
             token-spans (mapcat #(span/get-spans node doc-id %) token-sl-ids)

             sorted-tokens (sort-by :token/begin (reshape-into-token-grid tokens token-spans))
             line-enriched-tokens (filter :token/id (apply concat (-> sorted-tokens
                                                                      (ta/add-untokenized-substrings text)
                                                                      (ta/separate-into-lines text))))

             sentence-sl-ids (get-sentence-span-layers (:span-layer-scopes config))
             sentence-level-spans (mapcat #(span/get-spans node doc-id %) sentence-sl-ids)
             sentence-span-layers (map #(sl/get node %) sentence-sl-ids)]
         (log/info (vec sentence-span-layers))
         {:token-layer/name                 (:token-layer/name (gxe/entity node id))
          :token-layer/columnar-tokens      line-enriched-tokens
          :token-layer/sentence-level-spans sentence-level-spans
          :token-layer/token-span-layers    token-span-layers
          :token-layer/sentence-span-layers sentence-span-layers}))))

#?(:clj
   (pc/defmutation tokenize [{:keys [node] :as env} {:token-layer/keys [id]
                                                     doc-id            :document/id
                                                     text-id           :text/id
                                                     tokenization-scheme :tokenization}]
     {::pc/transform (ma/writeable-required :token-layer/id)}
     (cond
       (nil? (tokl/get node id))
       (server-error (str "Token layer does not exist:" id))

       (nil? (txt/get node text-id))
       (server-error (str "Text does not exist:" text-id))

       (nil? (doc/get node doc-id))
       (server-error (str "Doc does not exist:" doc-id))

       (not (#{:tokenization/whitespace :tokenization/morpheme} tokenization-scheme))
       (server-error (str "Unrecognized tokenization scheme:" tokenization-scheme))

       :else
       (let [success (condp = tokenization-scheme
                       :tokenization/whitespace (tokl/whitespace-tokenize node id doc-id text-id)
                       :tokenization/morpheme (tokl/morpheme-tokenize node id doc-id text-id))]
         (if success
           (server-message "Tokenization successful")
           (server-error "Tokenization failed"))))))

;; admin --------------------------------------------------------------------------------
;;
#?(:clj
   (pc/defmutation create-token-layer [{:keys [node]} {delta :delta [_ temp-id] :ident [_ parent-id] :parent-ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (let [new-token-layer (-> {} (mc/apply-delta delta) (select-keys token-layer-keys))]
       (let [{:keys [id success]} (tokl/create node new-token-layer)]
         (txtl/add-token-layer node parent-id id)
         (if-not success
           (server-error (str "Failed to create token-layer, please refresh and try again"))
           {:tempids {temp-id id}})))))

#?(:clj
   (pc/defmutation save-token-layer [{:keys [node]} {delta :delta [_ id] :ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (log/info (str "id:" (:ident params)))
     (let [valid? (mc/validate-delta record-valid? delta)]
       (cond
         ;; must be valid
         (not valid?)
         (server-error (str "Token layer delta invalid: " delta))
         :else
         (if-not (tokl/merge node id (mc/apply-delta {} delta))
           (server-error (str "Failed to save token-layer information, please refresh and try again"))
           (gxe/entity node id))))))

#?(:clj
   (pc/defmutation delete-token-layer [{:keys [node]} {[_ id] :ident :as params}]
     {::pc/transform ma/admin-required}
     (cond
       ;; ensure the token layer to be deleted exists
       (not (gxe/entity node id))
       (server-error (str "Token layer not found by ID " id))
       ;; otherwise, go ahead
       :else
       (let [name (:token-layer/name (gxe/entity node id))
             parent-id (tokl/parent-id node id)
             tx (into (tokl/delete** node id)
                      (txtl/remove-token-layer** node parent-id id))
             success (gxe/submit! node tx)]
         (if-not success
           (server-error (str "Failed to delete token layer " name ". Please refresh and try again"))
           (server-message (str "Token layer " name " deleted")))))))

#?(:clj
   (def token-layer-resolvers [get-token-layer get-tokens lorge-get-tokens lorge-get-columnar-tokens
                               create-token-layer save-token-layer delete-token-layer tokenize]))

