(ns glam.client.ui.document.grid-editor
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.client.ui.material-ui :as mui]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.mutations :as m]))

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
                                       (log/info "Tt" tokens)
                                       (some #(= (:token/id %) token-id) tokens))
                                     spans)]
          [id filtered-spans])))))

;; Only used for querying
(defsc Span
  [this {:span/keys [id value]}]
  {:query [:span/id :span/value :span/tokens]
   :ident :span/id})

(defsc SpanLayer
  [this {:span-layer/keys [id name spans]}]
  {:query [:span-layer/id :span-layer/name
           {:span-layer/spans (c/get-query Span)}]
   :ident :span-layer/id})

(defsc Token
  [this {:token/keys [id value]}]
  {:query [:token/id :token/value :token/begin :token/end]
   :ident :token/id})

;; Here is where the real UI begins
(defn ui-token [{:token/keys [id value] spans :spans}]
  (dom/div {:style {:display "inline-block"} :key id}
    (mui/box {:m 0.4 :p 0.4}
      (dom/div value)
      (mapv (fn [[sl-id spans]]
              (when (> (count spans) 1)
                (log/warn (str "Found a token " id " with more than one associated span in " sl-id "."
                               " Currently, this is not supported, and only the first span will be used.")))
              (if (empty? spans)
                (dom/div)
                (dom/div (-> spans first :span/value))))
            spans))))

(defsc TokenLayer
  [this {:token-layer/keys [id name tokens span-layers] :as token-layer}]
  {:query [:token-layer/id :token-layer/name
           {:token-layer/tokens (c/get-query Token)}
           {:token-layer/span-layers (c/get-query SpanLayer)}]
   :ident :token-layer/id}
  (let [tokens (sort-by :token/begin (reshape-into-token-grid token-layer))]
    (dom/div
      (mui/typography {:variant "h5"} name)
      (map ui-token tokens))))

(def ui-token-layer (c/factory TokenLayer {:keyfn :token-layer/id}))

;; Text --------------------------------------------------------------------------------
(defsc Text
  [this {:text/keys [id body]} {text-layer-name :text-layer/name}]
  {:query [:text/id :text/body]
   :ident :text/id}
  body)

(def ui-text (c/computed-factory Text {:keyfn :text/id}))

(defsc TextLayer
  [this {:text-layer/keys [id name text token-layers]}]
  {:query [:text-layer/name :text-layer/id
           {:text-layer/text (c/get-query Text)}
           {:text-layer/token-layers (c/get-query TokenLayer)}]
   :ident :text-layer/id}
  (dom/div
    ;; (ui-text (c/computed text {:text-layer/name name}))
    (mapv ui-token-layer token-layers)))

(def ui-text-layer (c/factory TextLayer {:keyfn :text-layer/id}))

(defsc GridEditor [this {:document/keys [id name text-layers] :as props}]
  {:query [:document/id :document/name
           {:document/text-layers (c/get-query TextLayer)}]
   :ident :document/id}
  (dom/p
    (str name))
  (when text-layers
    (c/fragment (mapv ui-text-layer text-layers))))

(def ui-grid-editor (c/factory GridEditor))


(comment

  (reshape-into-token-grid tl)

  (get-spans-for-token :tok1 (-> tl :token-layer/span-layers first :span-layer/spans))

  (def tl
    {:token-layer/id :tokl1,
     :token-layer/name "Token Layer 1",
     :token-layer/tokens
     [{:token/id :tok2,
       :token/value "sentence",
       :token/begin 5,
       :token/end 13}
      {:token/id :tok3,
       :token/value "is",
       :token/begin 14,
       :token/end 16}
      {:token/id :tok1,
       :token/value "This",
       :token/begin 0,
       :token/end 4}
      {:token/id :tok4,
       :token/value "great",
       :token/begin 17,
       :token/end 22}],
     :token-layer/span-layers
     [{:span-layer/id :sl1,
       :span-layer/name "Span Layer 1",
       :span-layer/spans
       [{:span/id :s2,
         :span/value "NN",
         :span/tokens [{:token/id :tok2}]}
        {:span/id :s1,
         :span/value "DT",
         :span/tokens [{:token/id :tok1}]}
        {:span/id :s4,
         :span/value "JJ",
         :span/tokens [{:token/id :tok4}]}
        {:span/id :s3,
         :span/value "VBZ",
         :span/tokens [{:token/id :tok3}]}]}]}
    )

  )
