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

;; TODO: this is display only for now, make full stack
(defsc Token
  [this {:token/keys [id value]}]
  {:query [:token/id :token/value]
   :ident :token/id}
  value)

(def ui-token (c/factory Token {:keyfn :token/id}))

(defsc TokenLayer
  [this {:token-layer/keys [id name tokens]}]
  {:query [:token-layer/id :token-layer/name
           {:token-layer/tokens (c/get-query Token)}]
   :ident :token-layer/id}
  (dom/div name (map ui-token tokens)))

(def ui-token-layer (c/factory TokenLayer {:keyfn :token-layer/id}))

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
    (map ui-token-layer token-layers)))

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