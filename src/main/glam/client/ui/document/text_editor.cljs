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

(defsc Text
  [this {:text/keys [id body]}]
  {:query [:text/id :text/body]
   :ident :text/id}
  (dom/div (str id ", " body)))

(defsc TextLayer
  [this {:text-layer/keys [id name]}]
  {:query [:text-layer/name :text-layer/id :text-layer/text ]
   :ident :text-layer/id}
  (pr-str id name))

(def ui-text (c/factory Text {:keyfn :text/id}))

(defsc TextEditor [this {:document/keys [id name texts] :as props}]
  {:query [:document/id :document/name
           {:document/texts (c/get-query Text)}
           {:document/text-layers (c/get-query TextLayer)}]
   :ident :document/id}
  (dom/p
    (str
      name))
  (when texts
    (c/fragment (mapv ui-text texts))))

(def ui-text-editor (c/factory TextEditor))