(ns glam.client.ui.document.token-editor
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.algorithms.merge :as merge]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.models.text :as txt]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.common.forms :as forms]
            [taoensso.timbre :as log]
            [glam.client.ui.material-ui-icon :as muic]
            [glam.client.ui.global-snackbar :as snack]))

;; TODO: this is display only for now, make full stack

(defsc Text
  [this {:text/keys [id body] :ui/keys [pristine-body busy?] :as props} {text-layer-name :text-layer/name
                                                                         document-id     :document/id
                                                                         text-layer-id   :text-layer/id}]
  {:query     [:text/id :text/body :ui/pristine-body :ui/busy?]
   :pre-merge (fn [{:keys [data-tree]}]
                ;; TODO: if pristine does not match body, warn user before we clobber their changes
                (merge {:ui/pristine-body (:text/body data-tree)
                        :ui/busy?         false}
                       data-tree))
   :ident     :text/id}
  )

(def ui-text (c/computed-factory Text {:keyfn :text/id}))

(defsc TextLayer
  [this {:text-layer/keys [id name text]} {document-id :document/id}]
  {:query     [:text-layer/name :text-layer/id
               {:text-layer/text (c/get-query Text)}]
   :ident     :text-layer/id}
  (dom/div
    (ui-text (c/computed text {:text-layer/name name
                               :text-layer/id   id
                               :document/id     document-id}))))

(def ui-text-layer (c/computed-factory TextLayer {:keyfn :text-layer/id}))

(defsc TokenEditor [this {:document/keys [id name text-layers] :as props}]
  {:query [:document/id :document/name
           {:document/text-layers (c/get-query TextLayer)}]
   :ident :document/id}
  (mui/container {:maxWidth "md"}
    (mui/box {:m 1}
      (mui/alert {:severity "info"}
        "Enter text however you like, with one exception: each sentence (or equivalent) should have one sentence.
        Also note that currently only whitespace tokenization is supported (this will change soon)."))
    (if (empty? text-layers)
      (mui/zero-state "No text layers exist.")
      (mapv ui-text-layer (map #(c/computed % {:document/id id}) text-layers)))))

(def ui-token-editor (c/factory TokenEditor))
