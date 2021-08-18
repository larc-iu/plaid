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

;; Span --------------------------------------------------------------------------------
(defsc Span
  [this {:span/keys [id value]}]
  {:query [:span/id :span/value]
   :ident :span/id}
  (dom/div value))

(def ui-span (c/factory Span {:keyfn :span/id}))

(defsc SpanLayer
  [this {:span-layer/keys [id name spans]}]
  {:query [:span-layer/id :span-layer/name
           {:span-layer/spans (c/get-query Span)}]
   :ident :span-layer/id}
  (dom/div name (mapv ui-span spans)))

(def ui-span-layer (c/factory SpanLayer {:keyfn :span-layer/id}))

;; Token --------------------------------------------------------------------------------
(defsc Token
  [this {:token/keys [id value]}]
  {:query [:token/id :token/value]
   :ident :token/id}
  (dom/div value))

(def ui-token (c/factory Token {:keyfn :token/id}))

(defsc TokenLayer
  [this {:token-layer/keys [id name tokens span-layers]}]
  {:query [:token-layer/id :token-layer/name
           {:token-layer/tokens (c/get-query Token)}
           {:token-layer/span-layers (c/get-query SpanLayer)}]
   :ident :token-layer/id}
  (dom/div
    (dom/div name (mapv ui-token tokens))
    (mapv ui-span-layer span-layers)))

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
    (ui-text (c/computed text {:text-layer/name name}))
    (mapv ui-token-layer token-layers)))

(def ui-text-layer (c/factory TextLayer {:keyfn :text-layer/id}))

(defsc GridEditor [this {:document/keys [id name text-layers] :as props}]
  {:query [:document/id :document/name
           {:document/text-layers (c/get-query TextLayer)}]
   :ident :document/id}
  (dom/p
    (str
      name))
  (when text-layers
    (c/fragment (mapv ui-text-layer text-layers))))

(def ui-grid-editor (c/factory GridEditor))