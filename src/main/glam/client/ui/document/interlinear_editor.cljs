(ns glam.client.ui.document.interlinear-editor
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [com.fulcrologic.fulcro.algorithms.react-interop :as interop]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.client.ui.material-ui :as mui]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.dom.html-entities :as ent]
            [com.fulcrologic.fulcro.mutations :as m]
            [glam.algos.text :as ta]
            [glam.models.span :as span]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]
            ["react-input-autosize" :default AutosizeInput]
            [glam.client.ui.global-snackbar :as snack]))

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


(declare batched-update)
(m/defmutation apply-schema
  "Called by g.c.u.d.document. Makes changes to the document on load to make it consistent with schematic requirements
  of the interface."
  [{:keys [data-tree]}]
  (action [{:keys [component ref]}]
          (let [document-id (last ref)
                config (get-in data-tree [:document/project :project/config :editors :interlinear])
                token-level-layer-ids (get-token-span-layers config)
                sentence-level-layer-ids (get-sentence-span-layers config)
                text-layers (:document/text-layers data-tree)
                all-batched-updates (atom [])]

            ;; Ensure that all token-level span layers have a span per-token
            (doseq [text-layer text-layers]
              (doseq [{:token-layer/keys [tokens] :as token-layer} (:text-layer/token-layers text-layer)]
                (doseq [{:span-layer/keys [id spans] :as sl} (filter #(token-level-layer-ids (:span-layer/id %))
                                                                     (:token-layer/span-layers token-layer))]
                  (let [batched-updates (atom [])]
                    (doseq [{:token/keys [id]} (spanless-tokens tokens spans)]
                      (swap! batched-updates conj
                             [:create {:span/value  ""
                                       :span/layer  (:span-layer/id sl)
                                       :span/tokens [id]}]))
                    (when-not (empty? @batched-updates)
                      (swap! all-batched-updates
                             conj
                             (batched-update {:document/id    document-id
                                              :span-layer/id  id
                                              :span-snapshots spans
                                              :updates        @batched-updates})))))))

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
                          batched-updates (atom [])
                          spans (atom spans-with-lines)]

                      ;; Check 1: if some spans span multiple lines, choose just one line (the smallest)
                      ;; TODO: just takes the lowest numbered line right now, probably we want to actually take the line
                      ;; with the most tokens associated with the given span
                      (reset! spans
                              (for [{lines :lines tokens :span/tokens id :span/id :as span} @spans]
                                (if (> (count lines) 1)
                                  (let [min-line (apply min lines)
                                        new-tokens (filterv #(= min-line (lines-by-token (:token/id %))) tokens)]
                                    (swap! batched-updates conj [:merge {:span/id id :span/tokens new-tokens}])
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
                          (swap! batched-updates conj [:delete id]))
                        (reset! spans (remove #(deleted-ids (:span/id %)) @spans)))

                      ;; Check 3: if some spans only incompletely span a line, expand them
                      (reset! spans
                              (for [{:span/keys [id tokens] :as span} @spans]
                                (let [line-num (lines-by-token (-> tokens first :token/id))
                                      line-tokens (tokens-by-line line-num)]
                                  (if-not (= (set line-tokens) (set (map :token/id tokens)))
                                    (do
                                      (swap! batched-updates conj [:merge {:span/id id :span/tokens (vec line-tokens)}])
                                      (assoc span :span/tokens (vec line-tokens)))
                                    span))))

                      ;; Check 4: if some lines entirely lack a span, create one
                      (let [needs-span (filterv (fn [n] (not-any? #((:lines %) n) @spans)) contentful-lines)]
                        (doseq [line-num needs-span]
                          (let [tokens-for-line (vec (tokens-by-line line-num))
                                record {:span/value "" :span/tokens tokens-for-line}]
                            (swap! batched-updates conj [:create record])
                            (swap! spans conj (assoc record :span/id (tempid/tempid))))))

                      (when-not (empty? @batched-updates)
                        (swap! all-batched-updates
                               conj
                               (batched-update {:document/id    document-id
                                                :span-layer/id  id
                                                :span-snapshots (map #(update % :span/tokens (fn [ts] (mapv :token/id ts)))
                                                                     (:span-layer/spans sl))
                                                :updates        @batched-updates}))))))))

            (when-not (empty? @all-batched-updates)
              (log/info "SUBMITTING " @all-batched-updates)
              (c/transact! component @all-batched-updates)))))
;; result action: unset :ui/busy? (think about it)

;; ui mutations ---------------------------------------------------------------------------------
(m/defmutation batched-update
  [params]
  (action [_] nil)
  (remote [{:keys [ast]}]
          (let [ast (assoc ast :key `span/batched-update)]
            ast)))

(m/defmutation save-span
  [{doc-id :document/id :as params}]
  (action [{:keys [state]}]
          ;; be optimistic
          nil)
  (remote [{:keys [ast]}]
          (let [ast (assoc ast :key `span/save-span)]
            ast))
  (result-action [{:keys [state ref app component] :as env}]
                 (let [{:server/keys [message error?]} (get-in env [:result :body `span/save-span])]
                   (log/info "Save processed: " message)
                   (when message
                     (if error?
                       (snack/message! {:message  message
                                        :severity (if error? "error" "success")})
                       (swap! state assoc-in (conj ref :ui/dirty?) false))))))

(m/defmutation create-span
  [{doc-id :document/id :as params}]
  (action [{:keys [state]}]
          ;; be optimistic
          nil)
  (remote [{:keys [ast]}]
          (let [ast (assoc ast :key `span/create-span)]
            ast))
  (result-action [{:keys [state ref app component] :as env}]
                 (let [{:server/keys [message error?]} (get-in env [:result :body `span/create-span])]
                   (log/info "Create processed: " message)
                   (when message
                     (if error?
                       (snack/message! {:message  message
                                        :severity (if error? "error" "success")})
                       (swap! state assoc-in (conj ref :ui/dirty?) false)))
                   (tempid/resolve-tempids! app (get-in env [:result :body])))))

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
(defn cell [props & children]
  (dom/div (merge {:style {:minHeight "12pt"}} props)
    children))

(defn flex-row [extra-props & children]
  (let [style (if (:style extra-props)
                (merge {:display "flex" :gap "6px"} (:style extra-props))
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
(defsc SpanCell [this {:span/keys [id] :as props} {token-id :token/id span-layer-id :span-layer/id :as cp}]
  {:ident              :span/id
   :query              [:span/id :span/value :ui/focused? :ui/dirty?]
   ;; Need to use local state here because otherwise we lose focus when another user triggers a refresh.
   :initLocalState     (fn [this props] {:value (or (:span/value props) "")})
   :componentDidUpdate (fn [this prev-props _]
                         (let [props (c/props this)]
                           (when-not (and (not (:ui/focused? props))
                                          (= (:span/value prev-props) (:span/value props)))
                             (c/set-state! this {:value (:span/value props)}))))}
  (let [{:keys [value]} (c/get-state this)]
    (cell {}
      (ui-autosize-input {:type       "text"
                          :value      value
                          :onChange   (fn [e]
                                        (m/set-string! this :span/value :event e)
                                        (m/set-value! this :ui/dirty? true)
                                        (c/set-state! this {:value (.-value (.-target e))}))
                          :onFocus    #(m/set-value! this :ui/focused? true)
                          :onBlur     (fn []
                                        (m/set-value! this :ui/focused? false)
                                        (when (:ui/dirty? props)
                                          (if (tempid/tempid? id)
                                            (c/transact! this [(create-span {:span/id     id
                                                                             :span/value  value
                                                                             :span/tokens [token-id]
                                                                             :span/layer  span-layer-id})])
                                            (c/transact! this [(save-span {:span/id    id
                                                                           :span/value value})]))))
                          :inputStyle {:minWidth        (str "30px")
                                       :display         "inline-block"
                                       :outline         "none"
                                       :border          "none"
                                       :borderRadius    "4px"
                                       :padding         "2px"
                                       :backgroundColor (if (:ui/focused? props) "#c6ffda" "transparent")}}))))
(def ui-span-cell (c/computed-factory SpanCell {:keyfn (comp str :span/id)}))

(defsc SentenceLevelSpan [this {:span/keys [id tokens] :ui/keys [focused? dirty?] :as props}]
  {:ident              :span/id
   :query              [:span/id :span/value :span/tokens :ui/focused? :ui/dirty?]
   ;; Need to use local state here because otherwise we lose focus when another user triggers a refresh.
   :initLocalState     (fn [this props] {:value (or (:span/value props) "")})
   :componentDidUpdate (fn [this prev-props _]
                         (let [props (c/props this)]
                           (when-not (and (not (:ui/focused? prev-props))
                                          (= (:span/value prev-props) (:span/value props)))
                             (c/set-state! this {:value (:span/value props)}))))}
  (let [{:keys [value]} (c/get-state this)]
    (ui-autosize-input {:type       "text"
                        :value      value
                        :onChange   (fn [e]
                                      (m/set-string! this :span/value :event e)
                                      (m/set-value! this :ui/dirty? true)
                                      (c/set-state! this {:value (.-value (.-target e))}))
                        :onFocus    #(m/set-value! this :ui/focused? true)
                        :onBlur     (fn []
                                      (m/set-value! this :ui/focused? false)
                                      (when dirty?
                                        (c/transact! this [(save-span {:span/id    id
                                                                       :span/value value})])))
                        :inputStyle {:minWidth        (str "300px")
                                     :display         "inline-block"
                                     :outline         "none"
                                     :border          "none"
                                     :borderRadius    "4px"
                                     :padding         "2px"
                                     :backgroundColor (if focused? "#c6ffda" "transparent")}})))
(def ui-sentence-level-span (c/computed-factory SentenceLevelSpan {:keyfn (comp str :span/id)}))

;; Here is where the real UI begins
(defn ui-token [config {:token/keys [id value] spans :spans :as props}]
  (let [token-span-layers (get-token-span-layers config)]
    (flex-col {:key id}
      (dom/div value)
      (mapv (fn [[sl-id spans]]
              (when (> (count spans) 1)
                (log/warn (str "Found a token " id " with more than one associated span in " sl-id "."
                               " Currently, this is not supported, and only the first span will be used.")))
              (when (= (count spans) 0)
                (log/error "Uh oh"))
              (ui-span-cell (c/computed (first spans)
                                        {:token/id      id
                                         :span-layer/id sl-id})))
            (filter #(token-span-layers (first %)) spans)))))

;; Where much of the work happens --------------------------------------------------------------------------------
(defsc TokenLayer
  [this {:token-layer/keys [id name tokens span-layers] :as token-layer} {:keys [text config]}]
  {:query [:token-layer/id :token-layer/name
           {:token-layer/tokens (c/get-query Token)}
           {:token-layer/span-layers (c/get-query SpanLayer)}]
   :ident :token-layer/id}
  (let [tokens (sort-by :token/begin (reshape-into-token-grid config token-layer))
        lines-with-strings (-> tokens
                               (ta/add-untokenized-substrings text)
                               (ta/separate-into-lines text))
        lines (map #(filter :token/id %) lines-with-strings)
        line->token-ids (get-line->token lines)
        token-span-layers (filter #((get-token-span-layers config) (:span-layer/id %)) span-layers)
        sentence-span-layers (filter #((get-sentence-span-layers config) (:span-layer/id %)) span-layers)]
    (dom/div
      ;; Title of the token layer
      (mui/typography {:variant "h5"} name)
      (map-indexed (fn [i line]
                     ;; TODO: fix for very long sentences. need to pull out two divs per line probably

                     ;; For each line...
                     (when-not (empty? (line->token-ids i))
                       (dom/div {:style {:backgroundColor (if (even? i) "#0055ff17" "white")
                                         :borderRadius    4
                                         :padding         "0.3em"}}

                         ;; Token-level rows
                         (flex-row {:style {:flexWrap "wrap"}}
                           ;; Titles
                           (flex-col {:key "title"}
                             ;; blank first cell--it's the tokens
                             (cell {:key "space"} (dom/div {} ent/nbsp))
                             ;; span layer titles
                             (mapv
                               (fn [sl]
                                 (cell {:key (str (:span-layer/id sl))
                                        :style {:fontVariant "small-caps"
                                                :fontWeight 700}}
                                   (:span-layer/name sl)))
                               token-span-layers))

                           ;; Token columns
                           (mapv (partial ui-token config) line))

                         ;; Sentence-level rows
                         (flex-row {:style {:marginTop "12px"}}
                           ;; Titles
                           (flex-col {:key "title"}
                             ;; span layer titles
                             (mapv
                               (fn [sl]
                                 (cell {:key (str (:span-layer/id sl))
                                        :style {:fontVariant "small-caps"
                                                :fontWeight 700}}
                                   (:span-layer/name sl)))
                               sentence-span-layers))

                           (flex-col {:key "spans"}
                             (for [{:span-layer/keys [id spans]} sentence-span-layers]
                               (let [tokens-for-line (set (line->token-ids i))
                                     span (some #(when (= tokens-for-line (set (map :token/id (:span/tokens %)))) %) spans)]
                                 (if span
                                   (ui-sentence-level-span span)
                                   (log/error "No span found for span layer " id "!")))))))))


                   lines))))

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
(defsc InterlinearEditor [this {:document/keys [id name text-layers project] :as props}]
  {:query [:document/id :document/name
           {:document/text-layers (c/get-query TextLayer)}
           {:document/project (c/get-query ProjectQuery)}]
   :ident :document/id}
  ;;(if (empty? (-> props :document/project :project/config))
  ;;  (dom/p "The interlinear editor must have at least one span layer designated as ")
  ;;  )
  (dom/div
    (when text-layers
      (c/fragment
        (mapv ui-text-layer (map #(c/computed % {:config (-> project :project/config :editors :interlinear)})
                                 text-layers))))))

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
