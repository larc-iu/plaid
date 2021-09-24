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

;; schema management --------------------------------------------------------------------------------
(m/defmutation apply-schema
  "See g.c.u.d.document"
  [{:keys [data-tree]}]
  (action [{:keys [state]}]
          (let [config (get-in data-tree [:document/project :project/config :editors :interlinear])]
            (log/info config)

            #_(doall
              (for [text-layer (:document/text-layers data-tree)]
                (do
                  (log/info "text" (:text-layer/text text-layer))
                  (doall
                    (for [token-layer (:text-layer/token-layers text-layer)]
                      (doall
                        (for [token (:token-layer/tokens token-layer)]
                          (log/info "token" token)))))))))))
;; result action: unset :ui/busy? (think about it)

;; ui mutations ---------------------------------------------------------------------------------
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
                   (when message
                     (if error?
                       (snack/message! {:message  message
                                        :severity (if error? "error" "success")})
                       (log/info message))))))

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
                   (when message
                     (if error?
                       (snack/message! {:message  message
                                        :severity (if error? "error" "success")})
                       (log/info message)))
                   (tempid/resolve-tempids! app (get-in env [:result :body])))))

(defn ensure-span-for-each-token
  "Given a data-tree from a pre-merge, modify it so that any tokens without at least one span will have a tempid span
   associated with it. Note that this alone does not cause any server-side changes."
  [{data :data-tree}]
  (let [span-layers (:token-layer/span-layers data)
        new-span-layers (let [tokens (:token-layer/tokens data)]
                          (for [{spans :span-layer/spans :as sl} span-layers]
                            (do
                              (log/info sl)
                              (let [no-span (filter (fn [{:token/keys [id]}]
                                                      (not
                                                        (some
                                                          #(some (fn [{token-id :token/id}] (= token-id id)) (:span/tokens %))
                                                          spans)))
                                                    tokens)
                                    new-spans (mapv (fn [{:token/keys [id]}]
                                                      {:span/id     (tempid/tempid)
                                                       :span/value  ""
                                                       :span/tokens [{:token/id id}]})
                                                    no-span)
                                    combined-spans (into (:span-layer/spans sl) new-spans)]
                                (assoc sl :span-layer/spans combined-spans)))))
        new-tree (assoc data :token-layer/span-layers (vec new-span-layers))]
    new-tree))

;; components --------------------------------------------------------------------------------
(defn reshape-into-token-grid
  "Given a token layer's data tree, returns the sequence of tokens where each token has
  been enriched with a :spans attribute containing a list of 2-tuples, where for each span
  in the layer that is linked to the token, the first item is the span layer's ID, and the
  second item is a sequence of all spans on that layer that were linkde to this token. Example:

      (reshape-into-token-grid tl)
      =>
      ({:token/id :tok2,
        :token/value \"sentence\",
        :token/begin 5,
        :token/end 13,
        :spans ([:sl1 (#:span{:id :s2, :value \"NN\", :tokens [#:token{:id :tok2}]})])
       ...)
  "
  [{:token-layer/keys [tokens span-layers]}]
  (for [{token-id :token/id :as token} tokens]
    (assoc token
      :spans
      (for [{:span-layer/keys [id spans]} span-layers]
        (let [filtered-spans (filter (fn [{:span/keys [tokens]}]
                                       (some #(= (:token/id %) token-id) tokens))
                                     spans)]
          [id filtered-spans])))))

;; Only used for querying
(defsc Span
  [this {:span/keys [id value]}]
  {:query     [:span/id :span/value :span/tokens :ui/focused?]
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

(defn cell [props & children]
  (dom/div (merge {:style {:minHeight "12pt"}} props)
    children))

;; note that this is NOT included in our query tree, we just need a component here to fire mutations
(defsc SpanCell [this {:span/keys [id value] :as props} {token-id :token/id span-layer-id :span-layer/id :as cp}]
  {:ident :span/id
   :query [:span/id :span/value :ui/focused?]}
  (cell {}
        (ui-autosize-input {:type       "text"
                            :value      value
                            :onChange   #(m/set-string! this :span/value :event %)
                            :onFocus    #(m/set-value! this :ui/focused? true)
                            :onBlur     (fn []
                                          (m/set-value! this :ui/focused? false)
                                          (when-not (= 0 (count value))
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
                                         :backgroundColor "transparent"}})))
(def ui-span-cell (c/computed-factory SpanCell {:keyfn (comp str :span/id)}))

;; Here is where the real UI begins
(defn ui-token [{:token/keys [id value] spans :spans}]
  (dom/div {:style {:display "inline-block"} :key id}
    (mui/box {:m 0.4 :p 0.4}
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
            spans))))

(defsc TokenLayer
  [this {:token-layer/keys [id name tokens span-layers] :as token-layer} {:keys [text config]}]
  {:query     [:token-layer/id :token-layer/name
               {:token-layer/tokens (c/get-query Token)}
               {:token-layer/span-layers (c/get-query SpanLayer)}]
   :pre-merge (fn [{:keys [data-tree] :as args}]
                (log/info data-tree)
                (ensure-span-for-each-token args))
   :ident     :token-layer/id}
  (let [tokens (sort-by :token/begin (reshape-into-token-grid token-layer))
        lines-with-strings (-> tokens
                               (ta/add-untokenized-substrings text)
                               (ta/separate-into-lines text))
        lines (map #(filter :token/id %) lines-with-strings)
        sentence-span-layer-ids (set (get-in config [:editors :interlinear :sentence-level-span-layers]))
        token-span-layers (filter #(not (sentence-span-layer-ids (:span-layer/id %))) span-layers)
        sentence-span-layers (filter #(sentence-span-layer-ids (:span-layer/id %)) span-layers)]
    (dom/div
      (mui/typography {:variant "h5"} name)
      (map-indexed (fn [i line]
                     (dom/div {:style {:backgroundColor (if (even? i) "#0055ff17" "white")
                                       :borderRadius    4}}

                       ;; todo: pull out a cell component
                       (dom/div {:style {:display "inline-block"}}
                         (cell {:key "space"} (dom/div {} ent/nbsp))
                         (mapv
                           (fn [sl]
                             (cell {:key (str (:span-layer/id sl))}
                                   (:span-layer/name sl)))
                           span-layers))
                       (map ui-token line)))
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
  (dom/p
    (str name))
  (when text-layers
    (c/fragment (mapv ui-text-layer (map #(c/computed % {:config (:project/config project)}) text-layers)))))

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
