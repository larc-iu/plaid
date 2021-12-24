(ns glam.client.ui.document.interlinear-editor
  (:require [goog.object :as gobj]
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
            ["react-virtualized-auto-sizer" :default AutoSizer]
            ["react-window" :refer [FixedSizeList]]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.client.ui.common.core :refer [loader]]
            [glam.client.ui.material-ui :as mui]
            [glam.algos.text :as ta]
            [glam.models.span :as span]
            [glam.client.ui.global-snackbar :as snack]))

(def ui-fixed-size-list (interop/react-factory FixedSizeList))
(def ui-auto-sizer (interop/react-factory AutoSizer))

(def ui-autosize-input (interop/react-factory AutosizeInput))
(defn get-token-span-layers [{:keys [span-layer-scopes]}]
  (->> span-layer-scopes (filter #(= (second %) :token)) keys set))
(defn get-sentence-span-layers [{:keys [span-layer-scopes]}]
  (->> span-layer-scopes (filter #(= (second %) :sentence)) keys set))

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

(defn reshape-into-token-grid
  "Given a token layer's data tree, returns the sequence of tokens where each token has
  been enriched with a :spans attribute containing a list of 2-tuples, where for each span
  in the layer that is linked to the token and is configured as a token-level span layer,
  the first item is the span layer's ID, and the second item is a sequence of all spans on
  that layer that were linkde to this token. Example:

      (reshape-into-token-grid tl)
      =>
      ({:token/id :tok2,
        :token/value \"sentence\",
        :token/begin 5,
        :token/end 13,
        :spans ([:sl1 (#:span{:id :s2, :value \"NN\", :tokens [#:token{:id :tok2}]})])
       ...)
  "
  [config {:token-layer/keys [tokens span-layers]}]
  (let [token-span-layers (get-token-span-layers config)]
    (for [{token-id :token/id :as token} tokens]
      (assoc token
        :spans
        (for [{:span-layer/keys [id spans]} (filter #(token-span-layers (:span-layer/id %)) span-layers)]
          (let [filtered-spans (filter (fn [{:span/keys [tokens]}]
                                         (some #(= (:token/id %) token-id) tokens))
                                       spans)]
            [id filtered-spans]))))))


(declare schema-batched-update)
(declare InterlinearEditor)
(m/defmutation apply-schema
  "Called by g.c.u.d.document. Makes changes to the document on load to make it consistent with schematic requirements
  of the interface."
  [{:keys [data-tree] document-id :document/id mark-ready? :ui/mark-ready?}]
  (action [{:keys [component app]}]
          (let [config (get-in data-tree [:document/project :project/config :editors :interlinear])
                token-level-layer-ids (get-token-span-layers config)
                sentence-level-layer-ids (get-sentence-span-layers config)
                text-layers (:document/text-layers data-tree)
                batches (atom [])]

            ;; Ensure that all token-level span layers have a span per-token
            (doseq [text-layer text-layers]
              (doseq [{:token-layer/keys [tokens] :as token-layer} (:text-layer/token-layers text-layer)]
                (doseq [{:span-layer/keys [id spans] :as sl} (filter #(token-level-layer-ids (:span-layer/id %))
                                                                     (:token-layer/span-layers token-layer))]
                  (let [updates (atom [])]
                    (doseq [{:token/keys [id]} (spanless-tokens tokens spans)]
                      (swap! updates conj
                             [:create {:span/value  ""
                                       :span/layer  (:span-layer/id sl)
                                       :span/tokens [id]}]))
                    (when-not (empty? @updates)
                      (swap! batches
                             conj
                             {:span-layer/id  id
                              :span-snapshots spans
                              :updates        @updates}))))))

            ;; Ensure that all sentence-level span layers have exactly one span per-token
            (doseq [{:text-layer/keys [text] :as text-layer} text-layers]
              (doseq [token-layer (:text-layer/token-layers text-layer)]
                (let [tokens (sort-by :token/begin (reshape-into-token-grid config token-layer))
                      lines-with-strings (-> tokens
                                             (ta/add-untokenized-substrings text)
                                             (ta/separate-into-lines text))
                      lines (map #(filter :token/id %) lines-with-strings)
                      contentful-lines (filter some? (map-indexed #(if (empty? %2) nil %1) lines))
                      tokens-by-line (get-line->token lines)
                      lines-by-token (get-token->line lines)]
                  (doseq [{:span-layer/keys [id spans] :as sl} (filter #(sentence-level-layer-ids (:span-layer/id %))
                                                                       (:token-layer/span-layers token-layer))]
                    (let [spans-with-lines (map (fn [span]
                                                  (assoc span :lines (set (map #(lines-by-token (:token/id %)) (:span/tokens span)))))
                                                spans)
                          updates (atom [])
                          spans (atom spans-with-lines)]

                      ;; Check 1: if some spans span multiple lines, choose just one line (the smallest)
                      ;; TODO: just takes the lowest numbered line right now, probably we want to actually take the line
                      ;; with the most tokens associated with the given span
                      (reset! spans
                              (for [{lines :lines tokens :span/tokens id :span/id :as span} @spans]
                                (if (> (count lines) 1)
                                  (let [min-line (apply min lines)
                                        new-tokens (filterv #(= min-line (lines-by-token (:token/id %))) tokens)]
                                    (swap! updates conj [:merge {:span/id id :span/tokens new-tokens}])
                                    (-> span
                                        (assoc :lines #{min-line})
                                        (assoc :span/tokens new-tokens)))
                                  span)))

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
                                (let [line-num (lines-by-token (-> tokens first :token/id))
                                      line-tokens (tokens-by-line line-num)]
                                  (if-not (= (set line-tokens) (set (map :token/id tokens)))
                                    (do
                                      (swap! updates conj [:merge {:span/id id :span/tokens (vec line-tokens)}])
                                      (assoc span :span/tokens (vec line-tokens)))
                                    span))))

                      ;; Check 4: if some lines entirely lack a span, create one
                      (let [needs-span (filterv (fn [n] (not-any? #((:lines %) n) @spans)) contentful-lines)]
                        (doseq [line-num needs-span]
                          (let [tokens-for-line (vec (tokens-by-line line-num))
                                record {:span/value "" :span/tokens tokens-for-line}]
                            (swap! updates conj [:create record])
                            (swap! spans conj (assoc record :span/id (tempid/tempid))))))

                      (when-not (empty? @updates)
                        (swap! batches
                               conj
                               {:span-layer/id  id
                                :span-snapshots (map #(update % :span/tokens (fn [ts] (mapv :token/id ts)))
                                                     (:span-layer/spans sl))
                                :updates        @updates})))))))

            (if-not (empty? @batches)
              (do
                (log/info "SUBMITTING " @batches)
                (c/transact! component [(schema-batched-update {:ui/mark-ready? mark-ready?
                                                                :document/id    document-id
                                                                :batches        @batches})]))
              ;; If we didn't need to make any updates, tell the router  we're all set
              (when mark-ready?
                (c/transact! app [(dr/target-ready {:target [:document/id document-id]})]))))))

;; ui mutations ---------------------------------------------------------------------------------
(m/defmutation schema-batched-update
  [{mark-ready? :ui/mark-ready?}]
  (action [{:keys [state ref]}]
          (log/info "busy!")
          (swap! state assoc-in (conj ref :ui/busy?) true))
  (remote [{:keys [ast]}]
          (let [ast (assoc ast :key `span/multi-layer-batched-update)]
            (log/info ast)
            ast))
  (result-action [{:keys [component state app result ref]}]
                 ;; TODO check for failure
                 (let [{:server/keys [message error?]} (get-in result [:body `span/multi-layer-batched-update])]
                   (log/info "Schema update error?" error?)
                   (log/info "Schema update message:" message))
                 (log/info "RESULT" result)
                 (let [target (conj ref :ui/busy?)]
                   ;; If this is the last schema update, tell the ruoter we're ready after the load is done
                   (swap! state assoc-in target false)
                   (df/load! app ref InterlinearEditor
                             {:post-action (fn []
                                             (when mark-ready?
                                               (dr/target-ready! component ref)))}))))

(m/defmutation save-span
  [{:span/keys [value]}]
  (action [{:keys [state ref]}]
          (swap! state assoc-in (conj ref :span/value) value))
  (remote [{:keys [ast]}]
          (let [ast (assoc ast :key `span/save-span)]
            ast))
  (result-action [{:keys [state ref app component] :as env}]
                 (let [{:server/keys [message error?]} (get-in env [:result :body `span/save-span])]
                   (log/info ref)
                   (log/info "Save processed: " message)
                   (when message
                     (if error?
                       (snack/message! {:message  message
                                        :severity (if error? "error" "success")})
                       (swap! state assoc-in (conj ref :ui/dirty?) false))))))

;; Query components --------------------------------------------------------------------------------
(defsc Span
  [this {:span/keys [id value]}]
  {:query     [:span/id :span/value :span/tokens :ui/focused? :ui/dirty?]
   :pre-merge (fn [{:keys [data-tree current-normalized]}]
                ;; If we're merging into a span that's currently being edited, keep its current value
                (if (:ui/focused? current-normalized)
                  (merge current-normalized
                         data-tree
                         {:span/value (:span/value current-normalized)})
                  (merge current-normalized
                         data-tree)))
   :ident     :span/id})

(defsc SpanLayer
  [this {:span-layer/keys [id name spans]}]
  {:query [:span-layer/id :span-layer/name
           {:span-layer/spans (c/get-query Span)}]
   ;; TODO maybe try to use pre-merge here to hold on to any existing tempid spans to resolve focus loss issue on temp spans
   :ident :span-layer/id})

(defsc Token
  [this {:token/keys [id value]}]
  {:query [:token/id :token/value :token/begin :token/end :token/text]
   :ident :token/id})

;; UI helpers --------------------------------------------------------------------------------
(defn merge-props-with-style [default extra]
  (if (:style extra)
    (let [style (merge (:style default) (:style extra))]
      (-> default (merge extra) (assoc :style style)))
    (merge default extra)))

(defn cell [props & children]
  (dom/div
    (merge-props-with-style {:style {:minHeight "12pt"}} props)
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

;; BE SURE to keep this in sync with Span, above: load queries look to Span, not SpanCell.
;; Why? See reshape-into-token-grid.
(defsc SentenceLevelSpan [this {:span/keys [id tokens] :as props}]
  {:ident              :span/id
   :query              [:span/id :span/value :span/tokens]
   ;; Need to use local state here because otherwise we lose focus when another user triggers a refresh.
   :initLocalState     (fn [this props] {:value (or (:span/value props) "")})
   :componentDidUpdate (fn [this prev-props _]
                         (let [props (c/props this)]
                           (when-not (and (not (:ui/focused? prev-props))
                                          (= (:span/value prev-props) (:span/value props)))
                             (c/set-state! this {:value (:span/value props)}))))}
  (let [{:keys [value] :ui/keys [focused? dirty?]} (c/get-state this)]
    (cell {}
      (ui-autosize-input {:type       "text"
                          :value      value
                          :onChange   (fn [e]
                                        (c/set-state! this {:value     (.-value (.-target e))
                                                            :ui/dirty? true}))
                          :onFocus    #(c/set-state! this (assoc (c/get-state this) :ui/focused? true))
                          :onBlur     (fn []
                                        (c/set-state! this (assoc (c/get-state this) :ui/focused? false))
                                        (when dirty?
                                          (c/transact! this [(save-span {:span/id    id
                                                                         :span/value value})]
                                                       {:on-result #(c/set-state! this (assoc (c/get-state this) :ui/dirty? false))})))
                          :inputStyle {:minWidth        "180px"
                                       :display         "inline-block"
                                       :outline         "none"
                                       :border          "none"
                                       :borderRadius    (if focused? "4px" "0")
                                       :padding         "2px"
                                       :borderBottom    (if focused?
                                                          ""
                                                          (if (= 0 (count value))
                                                            "dotted gray 1px"
                                                            "none"))
                                       :backgroundColor (if focused? "#e3ffe6" "transparent")}}))))
(def ui-sentence-level-span (c/computed-factory SentenceLevelSpan {:keyfn (comp str :span/id)}))

(defsc SpanCell [this {:span/keys [id] :as props} {token-id      :token/id
                                                   span-layer-id :span-layer/id
                                                   token-width   :token-width :as cp}]
  {:ident              :span/id
   :query              [:span/id :span/value]
   ;; Need to use local state here because otherwise we lose focus when another user triggers a refresh.
   :initLocalState     (fn [this props] {:value (or (:span/value props) "")})
   :componentDidUpdate (fn [this prev-props _]
                         (let [props (c/props this)]
                           (when-not (and (not (:ui/focused? props))
                                          (= (:span/value prev-props) (:span/value props)))
                             (c/set-state! this {:value (:span/value props)}))))}
  (let [{:keys [value] :ui/keys [focused? dirty?]} (c/get-state this)]
    (cell {}
      (ui-autosize-input
        {:type       "text"
         :value      (if focused? value (:span/value props))
         :onChange   (fn [e]
                       (c/set-state! this {:value     (.-value (.-target e))
                                           :ui/dirty? true}))
         :onFocus    #(c/set-state! this (assoc (c/get-state this) :ui/focused? true))
         :onBlur     (fn []
                       (c/set-state! this (assoc (c/get-state this) :ui/focused? false))
                       (when dirty?
                         (c/transact! this [(save-span {:span/id    id
                                                        :span/value value})]
                                      {:on-result #(c/set-state! this (assoc (c/get-state this) :ui/dirty? false))})))
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
(defsc TokenCell [this {:token/keys [id value] spans :spans :as props}]
  {:query             [:token/id :token/value :spans]
   :ident             :token/id
   :initLocalState    (fn [this props]
                        {:save-ref (fn [r]
                                     (gobj/set this "token-ref" r))})
   :componentDidMount (fn [this prev-props _]
                        ;; The first render sets up the ref but not in time for its width to be grabbed.
                        ;; Force another render on mount so that we have a chance to properly get the width of the ref.
                        (.forceUpdate this))}
  (let [save-ref (c/get-state this :save-ref)]
    (flex-col {:key id}
      (cell {} (dom/span {:ref save-ref} value))
      (mapv (fn [[sl-id spans]]
              (when (> (count spans) 1)
                (log/warn (str "Found a token " id " with more than one associated span in " sl-id "."
                               " Currently, this is not supported, and only the first span will be used.")))
              (when (> (count spans) 0)
                (ui-span-cell (c/computed (first spans)
                                          {:token/id      id
                                           :span-layer/id sl-id
                                           :token-width   (when-let [t (gobj/get this "token-ref")]
                                                            (.-width (.getBoundingClientRect t)))}))))
            spans))))
(def ui-token (c/factory TokenCell {:keyfn :token/id}))

;; Where much of the work happens --------------------------------------------------------------------------------
;; TODO debug
(defn- get-or-cache [this cache-key invalidator-value calc-fn]
  (let [state (c/get-state this)]
    (if (or (nil? (cache-key state))
            (not= invalidator-value (first (cache-key state))))
      (c/set-state! this (assoc state cache-key [invalidator-value (calc-fn)]))
      (second (cache-key state)))))

(defsc TokenLayer
  [this {:token-layer/keys [id name tokens span-layers] :ui/keys [page] :as token-layer} {:keys [text config]}]
  {:query                [:token-layer/id :token-layer/name
                          {:token-layer/tokens (c/get-query Token)}
                          {:token-layer/span-layers (c/get-query SpanLayer)}
                          :ui/page]
   :initLocalState       (fn [this props]
                           {})
   :pre-merge            (fn [{:keys [data-tree current-normalized]}]
                           (assoc data-tree :ui/page 1 (or (:ui/page current-normalized) 1)))
   :componentWillUnmount (fn [this] (m/set-value! this :ui/page 1))
   :ident                :token-layer/id}
  (let [tokens (sort-by :token/begin (reshape-into-token-grid config token-layer))
        lines-with-strings (-> tokens
                               (ta/add-untokenized-substrings text)
                               (ta/separate-into-lines text))
        lines (map #(filter :token/id %) lines-with-strings)
        line->token-ids (get-line->token lines)
        filtered-lines (map second (filter #(not-empty (line->token-ids (first %))) (map-indexed (fn [i v] [i v]) lines)))
        line->token-ids (get-line->token filtered-lines)
        token-span-layers (filter #((get-token-span-layers config) (:span-layer/id %)) span-layers)
        sentence-span-layers (filter #((get-sentence-span-layers config) (:span-layer/id %)) span-layers)
        render-line
        (fn [[i line]]
          ;; For each line...
          (dom/div {:style {:backgroundColor (if (even? i) "#0055ff17" "white")
                            :borderRadius    4
                            :padding         "0.3em"
                            :marginBottom    "1em"}}

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
              (mapv ui-token line))

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
                (for [{:span-layer/keys [id spans]} sentence-span-layers]
                  (let [tokens-for-line (set (line->token-ids i))
                        span (some #(when (= tokens-for-line (set (map :token/id (:span/tokens %)))) %) spans)]
                    (when span
                      (ui-sentence-level-span span))))))))]

    (let [page-count 10
          pagination (fn []
                       (when (> (count filtered-lines) page-count)
                         (mui/pagination
                           {:count    (js/Math.ceil (/ (count filtered-lines) page-count))
                            :page     page
                            :onChange #(m/set-integer! this :ui/page :value %2)})))]
      (mui/card {}
        (mui/card-header {:action (pagination)
                          :title  name})

        #_(mui/typography {:variant "h5" :style {:marginBottom "1em"}} name)

        (mui/card-content {}
          (mapv render-line (->> filtered-lines
                                 (drop (* page-count (dec page)))
                                 (take page-count)
                                 (map-indexed (fn [i v] [i v])))))

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
