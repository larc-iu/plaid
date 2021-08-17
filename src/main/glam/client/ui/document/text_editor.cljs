(ns glam.client.ui.document.text-editor
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

(defsc Text
  [this {:text/keys [id body]} {text-layer-name :text-layer/name}]
  {:query [:text/id :text/body]
   :ident :text/id}
  (mui/text-field
    {:multiline true
     :variant "outlined"
     :fullWidth true
     :label text-layer-name
     :value body
     :onChange #(m/set-string! this :text/body :event %)}))

(def ui-text (c/computed-factory Text {:keyfn :text/id}))

(defsc TextLayer
  [this {:text-layer/keys [id name text]}]
  {:query [:text-layer/name :text-layer/id
           {:text-layer/text (c/get-query Text)}]
   :ident :text-layer/id}
  (dom/div
    (ui-text (c/computed text {:text-layer/name name}))))

(def ui-text-layer (c/factory TextLayer {:keyfn :text-layer/id}))

(defsc TextEditor [this {:document/keys [id name text-layers] :as props}]
  {:query [:document/id :document/name
           {:document/text-layers (c/get-query TextLayer)}]
   :ident :document/id}
  (mui/container {:maxWidth "md"}
    (dom/p
      (str
        name))
    (when text-layers
      (c/fragment (mapv ui-text-layer text-layers)))))

(def ui-text-editor (c/factory TextEditor))