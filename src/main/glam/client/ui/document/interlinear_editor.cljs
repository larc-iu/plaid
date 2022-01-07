(ns glam.client.ui.document.interlinear-editor
  (:require [goog.object :as gobj]
            [clojure.set :refer [difference]]
            [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [com.fulcrologic.fulcro.algorithms.react-interop :as interop]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.dom.html-entities :as ent]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]
            [taoensso.timbre :as log]
            ["react-input-autosize" :default AutosizeInput]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.client.ui.common.core :refer [loader]]
            [glam.client.ui.material-ui :as mui]
            [glam.algos.text :as ta]
            [glam.models.token-layer :as tokl]
            [glam.models.span :as span]
            [glam.client.ui.global-snackbar :as snack]))

(def ui-autosize-input (interop/react-factory AutosizeInput))

;; schema management --------------------------------------------------------------------------------
(defn get-line->token [lines]
  (apply merge (map-indexed (fn [i ts] {i (set (map :token/id ts))}) lines)))
(defn get-token->line [lines]
  (apply merge (map-indexed (fn [i ts] (into {} (for [t ts] [(:token/id t) i]))) lines)))
(defn spanless-tokens
  "Given some tokens and spans, find the tokens which are not referred to by any span."
  [tokens spans]
  (filter (fn [{:token/keys [id]}]
            (not
              (some
                #(some (fn [{token-id :token/id}] (= token-id id)) (:span/tokens %))
                spans)))
          tokens))

(declare InterlinearEditor)
(m/defmutation schema-update
  [{mark-ready? :ui/mark-ready? document-id :document/id}]
  (action [{:keys [state ref]}]
    (log/info "busy!")
    (swap! state assoc-in [:document/id document-id :ui/busy?] true))
  (remote [{:keys [ast]}]
          (let [ast (assoc ast :key `span/multi-layer-batched-update)]
            (log/info ast)
            ast))
  (result-action [{:keys [state app result]}]
                 ;; TODO check for failure
                 (let [{:server/keys [message error?]} (get-in result [:body `span/multi-layer-batched-update])]
                   (log/info "Schema update error?" error?)
                   (log/info "Schema update message:" message))
                 (log/info "RESULT" result)
                 (let [ident [:document/id document-id]
                       target (conj ident :ui/busy?)]
                   ;; If this is the last schema update, tell the ruoter we're ready after the load is done
                   (df/load! app ident InterlinearEditor
                             {:post-action (fn []
                                             (swap! state assoc-in target false)
                                             (when mark-ready?
                                               (dr/target-ready! app ident)))}))))

(m/defmutation apply-schema
  "Called by g.c.u.d.document. Makes changes to the document on load to make it consistent with schematic requirements
  of the interface."
  [{:keys [data-tree] document-id :document/id mark-ready? :ui/mark-ready?}]
  (action [{:keys [app]}]
    (let [text-layers (:document/text-layers data-tree)
          batches (atom [])
          get-snapshots (memoize (fn [token-layer]
                                   (group-by :span/layer
                                             (mapcat :token/spans
                                                     (:token-layer/columnar-tokens token-layer)))))]

      ;; Ensure that all token-level span layers have a span per-token
      (doseq [text-layer text-layers]
        (doseq [token-layer (:text-layer/token-layers text-layer)]
          ;; For each token-level span layer...
          (doseq [{sl-id :span-layer/id} (:token-layer/token-span-layers token-layer)]
            (let [updates (atom [])]
              ;; For each token...
              (doseq [{:token/keys [id spans] :as tok} (:token-layer/columnar-tokens token-layer)]
                ;; Check how many spans there are for this layer
                (let [spans-for-layer (filter #(= (:span/layer %) sl-id) spans)]
                  ;; If there's no span for that token for that span layer, create one
                  (when (empty? spans-for-layer)
                    (swap! updates conj
                           [:create {:span/value  ""
                                     :span/layer  sl-id
                                     :span/tokens [id]}]))
                  ;; If there's more than one span for that token, delete the others
                  (when-let [{:span/keys [id]} (seq (rest spans-for-layer))]
                    (swap! updates conj
                           [:delete id]))))

              (when-not (empty? @updates)
                (swap! batches
                       conj
                       {:span-layer/id  sl-id
                        :span-snapshots ((get-snapshots token-layer) sl-id)
                        :updates        @updates}))))))

      ;; Ensure that all sentence-level span layers have exactly one span per-token
      (doseq [text-layer text-layers]
        (doseq [token-layer (:text-layer/token-layers text-layer)]
          (let [tokens (:token-layer/columnar-tokens token-layer)
                contentful-lines (set (map :token/line tokens))
                token-index (into {} (map (fn [v] [(:token/id v) v]) tokens))
                line->tokens (group-by :token/line tokens)]
            (doseq [{sl-id :span-layer/id} (:token-layer/sentence-span-layers token-layer)]
              (let [updates (atom [])
                    spans (atom (filterv #(= (:span/layer %) sl-id) (:token-layer/sentence-level-spans token-layer)))]

                ;; Check 1: if some spans span multiple lines, choose just one line (the smallest)
                ;; TODO: just takes the lowest numbered line right now, probably we want to actually take the line
                ;; with the most tokens associated with the given span
                (reset! spans
                        (mapv (fn [{tokens :span/tokens id :span/id :as span}]
                                (let [lines (map (comp :token/line #(get token-index %)) tokens)]
                                  (if (> (count (set lines)) 1)
                                    (let [min-line (apply min lines)
                                          new-tokens (filterv #(= min-line (line->tokens (:token/id %))) tokens)]
                                      (swap! updates conj [:merge {:span/id id :span/tokens new-tokens}])
                                      (-> span
                                          (assoc :lines #{min-line})
                                          (assoc :span/tokens new-tokens)))
                                    (assoc span :lines (set lines)))))
                              @spans))

                ;; Check 2: if a line has more than one span, choose the longest one and delete the rest
                (let [spans-by-line (into {} (for [line-number contentful-lines]
                                               [line-number (->> @spans
                                                                 (filter #(contains? (:lines %) line-number))
                                                                 (sort #(- (count (:span/tokens %)))))]))
                      deleted-ids (->> spans-by-line
                                       vals
                                       (map :span/id)
                                       (mapcat #(drop 1 %))
                                       set)]
                  (doseq [id deleted-ids]
                    (swap! updates conj [:delete id]))
                  (reset! spans (remove #(deleted-ids (:span/id %)) @spans)))

                ;; Check 3: if some spans only incompletely span a line, expand them
                (reset! spans
                        (for [{:span/keys [id tokens] :as span} @spans]
                          (let [line-num (-> span :lines first)
                                line-token-ids (mapv :token/id (line->tokens line-num))]
                            (if-not (= (set line-token-ids) (set tokens))
                              (do
                                (swap! updates conj [:merge {:span/id id :span/tokens line-token-ids}])
                                (assoc span :span/tokens line-token-ids))
                              span))))

                ;; Check 4: if some lines entirely lack a span, create one
                (let [covered-lines (set (mapcat #(->> (% :span/tokens)
                                                       (map token-index)
                                                       (map :token/line))
                                                 @spans))
                      needs-span (difference contentful-lines covered-lines)]
                  (doseq [line-num needs-span]
                    (let [tokens-for-line (mapv :token/id (line->tokens line-num))
                          record {:span/value "" :span/tokens tokens-for-line}]
                      (swap! updates conj [:create record])
                      (swap! spans conj (assoc record :span/id (tempid/tempid))))))

                (when-not (empty? @updates)
                  (swap! batches
                         conj
                         {:span-layer/id  sl-id
                          :span-snapshots ((get-snapshots token-layer) sl-id)
                          :updates        @updates})))))))

      (if-not (empty? @batches)
        (do
          (c/transact! app
                       [(schema-update {:ui/mark-ready? mark-ready?
                                        :document/id    document-id
                                        :batches        @batches})]))
        ;; If we didn't need to make any updates, tell the router  we're all set
        (when mark-ready?
          (c/transact! app [(dr/target-ready {:target [:document/id document-id]})]))))))

;; ui mutations ---------------------------------------------------------------------------------
(m/defmutation save-span
  [{:span/keys [value] ok-action :ok-action}]
  (action [{:keys [state ref]}]
    (swap! state assoc-in (conj ref :span/value) value))
  (remote [{:keys [ast]}]
          (-> ast
              (assoc :key `span/save-span)
              (update :params dissoc :ok-action)))
  (result-action [{:keys [state ref] :as env}]
                 (let [{:server/keys [message error?]} (get-in env [:result :body `span/save-span])]
                   (log/info ref)
                   (log/info "Save processed: " message)
                   (when message
                     (if error?
                       (snack/message! {:message  message
                                        :severity (if error? "error" "success")})
                       (swap! state assoc-in (conj ref :ui/dirty?) false)))
                   (when (and (not error?) ok-action)
                     (ok-action)))))

;; UI helpers --------------------------------------------------------------------------------
(defn merge-props-with-style [default extra]
  (if (:style extra)
    (let [style (merge (:style default) (:style extra))]
      (-> default (merge extra) (assoc :style style)))
    (merge default extra)))

(defn cell [props & children]
  (dom/div
    (merge-props-with-style {:style {:minHeight "18pt"}} props)
    children))

(defn flex-row [extra-props & children]
  (let [style (if (:style extra-props)
                (merge {:display "flex" :gap "10px"} (:style extra-props))
                {:display "flex" :gap "6px"})]
    (dom/div (merge extra-props
                    {:style style})
      children)))

(defn flex-col [extra-props & children]
  (let [style (if (:style extra-props)
                (merge {:display "flex" :flex-direction "column" :gap "6px"} (:style extra-props))
                {:display "flex" :flex-direction "column" :gap "6px"})]
    (dom/div (merge extra-props
                    {:style style})
      children)))

(defsc SpanCell [this {:span/keys [id tokens] :as props} {token-width :token-width :as cp}]
  {:ident              :span/id
   :query              [:span/id :span/value :span/layer :span/tokens]
   :pre-merge          (fn [{:keys [data-tree current-normalized]}]
                         ;; If we're merging into a span that's currently being edited, keep its current value
                         (if (:ui/focused? current-normalized)
                           (merge current-normalized
                                  data-tree
                                  {:span/value (:span/value current-normalized)})
                           (merge current-normalized
                                  data-tree)))
   ;; Need to use local state here for value because otherwise we lose focus when another user triggers a refresh.
   :initLocalState     (fn [this {:span/keys [id] :as props}]
                         (let [on-save-result (fn []
                                                (log/info "Undirtying")
                                                (c/set-state! this (assoc (c/get-state this) :ui/dirty? false)))]
                           {:value     (or (:span/value props) "")
                            :on-blur   (fn []
                                         (let [{:ui/keys [dirty?] value :value :as state} (c/get-state this)]
                                           (c/set-state! this (assoc state :ui/focused? false))
                                           (when dirty?
                                             (c/transact! this [(save-span {:span/id    id
                                                                            :span/value value
                                                                            :ok-action  on-save-result})]))))
                            :on-focus  #(c/set-state! this (assoc (c/get-state this) :ui/focused? true))
                            :on-change (fn [e]
                                         (log/info "Changed")
                                         (c/set-state! this {:value     (.-value (.-target e))
                                                             :ui/dirty? true}))}))
   :componentDidUpdate (fn [this prev-props _]
                         (let [props (c/props this)]
                           (when-not (and (not (:ui/focused? props))
                                          (= (:span/value prev-props) (:span/value props)))
                             (c/set-state! this {:value (:span/value props)}))))}
  (let [{:keys [value on-blur on-focus on-change] :ui/keys [focused? dirty?]} (c/get-state this)]
    (cell {}
      (ui-autosize-input
        {:type       "text"
         :value      (if focused? value (:span/value props))
         :onChange   on-change
         :onFocus    on-focus
         :onBlur     on-blur
         :inputStyle {:minWidth        (or (and token-width (str (max (- token-width 4) 20) "px"))
                                           "20px")
                      :display         "inline-block"
                      :outline         "none"
                      :border          "none"
                      :borderRadius    (if focused? "4px" "0")
                      :borderBottom    (if focused?
                                         ""
                                         (if (= 0 (count value))
                                           "dotted gray 1px"
                                           "none"))
                      :backgroundColor (if focused? "#e3ffe6" "transparent")}}))))
(def ui-span-cell (c/computed-factory SpanCell {:keyfn (comp str :span/id)}))

;; Here is where the real UI begins
(defsc ColumnarToken [this {:token/keys [id value spans] :as props}]
  {:query             [:token/id :token/value :token/begin :token/end :token/line {:token/spans (c/get-query SpanCell)}]
   :ident             :token/id
   :initLocalState    (fn [this props]
                        {:save-ref #(gobj/set this "token-ref" %)})
   :componentDidMount (fn [this prev-props _]
                        ;; The first render sets up the ref but not in time for its width to be grabbed.
                        ;; Force another render on mount so that we have a chance to properly get the width of the ref.
                        (.forceUpdate this))}
  (let [save-ref (c/get-state this :save-ref)
        grouped-spans (group-by :span/layer spans)]
    (flex-col {:key id}
      (cell {} (dom/span {:ref save-ref} value))
      (mapv (fn [[sl spans]]
              (when (> (count spans) 1)
                (log/warn (str "Found a token " id " with more than one associated span in " (:span/layer (first spans)) "."
                               " Currently, this is not supported, and only the first span will be used.")))
              (when (> (count spans) 0)
                (ui-span-cell (c/computed (first spans)
                                          {:token/id    id
                                           :token-width (when-let [t (gobj/get this "token-ref")]
                                                          (.-width (.getBoundingClientRect t)))}))))
            grouped-spans))))
(def ui-columnar-token (c/factory ColumnarToken {:keyfn :token/id}))

;; Where much of the work happens --------------------------------------------------------------------------------
;; TODO debug
(defn- get-or-cache [this cache-key invalidator-value calc-fn]
  (let [state (c/get-state this)]
    (if (or (nil? (cache-key state))
            (not= invalidator-value (first (cache-key state))))
      (c/set-state! this (assoc state cache-key [invalidator-value (calc-fn)]))
      (second (cache-key state)))))

(defsc SpanLayer [_ _]
  {:ident :span-layer/id
   :query [:span-layer/id :span-layer/name]})

(defn render-tokens [tokens]
  (let [chunks (loop [[{:token/keys [end] :as t1} {:token/keys [begin] :as t2} :as tokens] tokens
                      chunk []
                      chunks []]
                 (cond (nil? t1)
                       chunks

                       (nil? t2)
                       (conj chunks (conj chunk t1))

                       (= end begin)
                       (recur (rest tokens)
                              (conj chunk t1)
                              chunks)

                       :else
                       (recur (rest tokens)
                              []
                              (conj chunks (conj chunk t1)))))]
    (mapv (fn [chunk]
            (flex-row {:style {:gap "2px"}}
              (mapv ui-columnar-token chunk)))
          chunks)))

(defsc TokenLayer
  [this
   {:token-layer/keys [id name columnar-tokens sentence-level-spans token-span-layers sentence-span-layers]
    :ui/keys          [page] :as token-layer}
   {:keys [text config]}]
  {:query                [:token-layer/id :token-layer/name
                          {:token-layer/columnar-tokens (c/get-query ColumnarToken)}
                          {:token-layer/sentence-level-spans (c/get-query SpanCell)}
                          {:token-layer/token-span-layers (c/get-query SpanLayer)}
                          {:token-layer/sentence-span-layers (c/get-query SpanLayer)}
                          :ui/page]
   :initLocalState       (fn [this props]
                           {:on-page-change #(m/set-integer! this :ui/page :value %2)})
   :pre-merge            (fn [{:keys [data-tree current-normalized]}]
                           (assoc data-tree :ui/page 1 (or (:ui/page current-normalized) 1)))
   :componentWillUnmount (fn [this] (m/set-value! this :ui/page 1))
   :ident                :token-layer/id}
  ;; TODO remap lines to avoid empty lines
  (let [contentful-lines (set (map :token/line columnar-tokens))
        line-remapping (into {} (map (fn [orig new] [orig new])
                                     (sort contentful-lines)
                                     (range (count contentful-lines))))
        tokens-by-line (group-by (comp line-remapping :token/line) columnar-tokens)

        tokens-by-id (into {} (for [{id :token/id :as token} columnar-tokens] [id token]))
        line-count (count contentful-lines)
        sentence-level-spans-by-line (group-by (comp line-remapping :token/line tokens-by-id first :span/tokens) sentence-level-spans)
        {:keys [on-page-change]} (c/get-state this)
        render-line
        (fn [{:keys [i tokens hidden?]}]
          ;; For each line...
          (dom/div {:style {:backgroundColor (if (even? i) "#0055ff17" "white")
                            :borderRadius    4
                            :padding         "0.3em"
                            :marginBottom    "1em"
                            :display         (if hidden? "none" "block")
                            :overflow        "scroll"}
                    :key   (str "line" i)}

            ;; Token-level
            (flex-row {:style {:flexWrap "wrap" :marginBottom "20px"}}
              ;; Title column
              (flex-col {:key "title" :style {:marginBottom "20px"}}
                (cell {:key "space"} (dom/div {} ent/nbsp))
                (mapv
                  (fn [sl]
                    (cell {:key   (str (:span-layer/id sl))
                           :style {:fontVariant "small-caps"
                                   :fontWeight  700}}
                      (:span-layer/name sl)))
                  token-span-layers))

              ;; Token columns
              (render-tokens tokens))

            ;; Sentence-level
            (flex-row {:style {:marginTop "12px"}}
              ;; Title column
              (flex-col {:key "title"}
                (mapv
                  (fn [sl]
                    (cell {:key   (str (:span-layer/id sl))
                           :style {:fontVariant "small-caps"
                                   :fontWeight  700}}
                      (:span-layer/name sl)))
                  sentence-span-layers))

              (flex-col {:key "spans"}
                (for [sl-id (map :span-layer/id sentence-span-layers)]
                  (let [span (some #(when (= (:span/layer %) sl-id) %) (sentence-level-spans-by-line i))]
                    (when span
                      (ui-span-cell (c/computed span {:token-width 180})))))))))]
    (let [page-count 10
          pagination (fn []
                       (when (> line-count page-count)
                         (mui/pagination
                           {:count    (js/Math.ceil (/ line-count page-count))
                            :page     page
                            :onChange on-page-change})))]
      (mui/card {}
        (mui/card-header {:action (pagination)
                          :title  name})

        (if-not (seq contentful-lines)
          (mui/box {:m 2}
            (mui/typography {:variant "subtitle"} "No tokens available"))
          (mui/card-content {}
            (mapv render-line (map (fn [i]
                                     {:i      i
                                      :tokens (tokens-by-line i)})
                                   (range (* page-count (dec page))
                                          (min line-count (* page-count page)))))))

        (mui/card-actions {}
          (pagination))))))

(def ui-token-layer (c/computed-factory TokenLayer {:keyfn :token-layer/id}))

;; Text --------------------------------------------------------------------------------
(defsc Text
  [this {:text/keys [id body]} {text-layer-name :text-layer/name}]
  {:query [:text/id :text/body :text/document]
   :ident :text/id}
  body)

(def ui-text (c/computed-factory Text {:keyfn :text/id}))

(defsc TextLayer
  [this {:text-layer/keys [id name text token-layers]} {:keys [config]}]
  {:query [:text-layer/name :text-layer/id
           {:text-layer/text (c/get-query Text)}
           {:text-layer/token-layers (c/get-query TokenLayer)}]
   :ident :text-layer/id}
  (dom/div
    ;; (ui-text (c/computed text {:text-layer/name name}))
    (mapv ui-token-layer (map #(c/computed % {:text text :config config}) token-layers))))

(def ui-text-layer (c/computed-factory TextLayer {:keyfn :text-layer/id}))

(defsc ProjectQuery [_ _] {:ident :project/id :query [:project/config :project/id]})
(defsc InterlinearEditor [this {:document/keys [id name text-layers project] :ui/keys [busy?] :as props}]
  {:query     [:document/id :document/name
               {:document/text-layers (c/get-query TextLayer)}
               {:document/project (c/get-query ProjectQuery)}
               :ui/busy?]
   :pre-merge (fn [{:keys [data-tree]}]
                (merge {:ui/busy? false}
                       data-tree))
   :ident     :document/id}
  ;;(if (empty? (-> props :document/project :project/config))
  ;;  (dom/p "The interlinear editor must have at least one span layer designated as ")
  ;;  )
  (dom/div
    (if busy?
      (loader)
      (when text-layers
        (c/fragment
          (mapv ui-text-layer (map #(c/computed % {:config (-> project :project/config :editors :interlinear)})
                                   text-layers)))))))

(def ui-interlinear-editor (c/factory InterlinearEditor))


(comment

  (reshape-into-token-grid tl)

  (get-spans-for-token :tok1 (-> tl :token-layer/span-layers first :span-layer/spans))

  (def tl
    {:token-layer/id   :tokl1,
     :token-layer/name "Token Layer 1",
     :token-layer/tokens
     [{:token/id    :tok2,
       :token/value "sentence",
       :token/begin 5,
       :token/end   13}
      {:token/id    :tok3,
       :token/value "is",
       :token/begin 14,
       :token/end   16}
      {:token/id    :tok1,
       :token/value "This",
       :token/begin 0,
       :token/end   4}
      {:token/id    :tok4,
       :token/value "great",
       :token/begin 17,
       :token/end   22}],
     :token-layer/span-layers
     [{:span-layer/id   :sl1,
       :span-layer/name "Span Layer 1",
       :span-layer/spans
       [{:span/id     :s2,
         :span/value  "NN",
         :span/tokens [{:token/id :tok2}]}
        {:span/id     :s1,
         :span/value  "DT",
         :span/tokens [{:token/id :tok1}]}
        {:span/id     :s4,
         :span/value  "JJ",
         :span/tokens [{:token/id :tok4}]}
        {:span/id     :s3,
         :span/value  "VBZ",
         :span/tokens [{:token/id :tok3}]}]}]}
    )

  )
