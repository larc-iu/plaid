(ns glam.client.ui.document.text-editor
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.algorithms.merge :as merge]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.client.ui.material-ui :as mui]
            [taoensso.timbre :as log]))

;; TODO: this is display only for now, make full stack

(defsc Text
  [this {:text/keys [id body] :ui/keys [pristine-body]} {text-layer-name :text-layer/name}]
  {:query     [:text/id :text/body :ui/pristine-body]
   :pre-merge (fn [{:keys [data-tree]}]
                ;; TODO: if pristine does not match body, warn user before we clobber their changes
                (merge {:ui/pristine-body (:text/body data-tree)}
                       data-tree))
   :ident     :text/id}
  (mui/text-field
    {:multiline true
     :variant   "outlined"
     :fullWidth true
     :label     text-layer-name
     :value     body
     :onChange  #(m/set-string! this :text/body :event %)
     :onPaste   (fn [e]
                  (if (> 0 (count (.toString (js/window.getSelection))))
                    (do
                      (.preventDefault e)
                      (js/alert (str "Pasting while text is selected is not supported. "
                                     "Please unselect the text and try pasting again.")))
                    '...)

                  )}

    ))

(def ui-text (c/computed-factory Text {:keyfn :text/id}))

(defsc TextLayer
  [this {:text-layer/keys [id name text]}]
  {:query     [:text-layer/name :text-layer/id
               {:text-layer/text (c/get-query Text)}]
   :pre-merge (fn [{:keys [data-tree query current-normalized]}]
                ;; If we don't have a text, make a tempid and chug along
                (merge
                  (if (merge/not-found? data-tree :text-layer/text)
                    (assoc data-tree :text-layer/text {:text/id   (tempid/tempid)
                                                       :text/body ""})
                    data-tree)))
   :ident     :text-layer/id}
  (dom/div
    (ui-text (c/computed text {:text-layer/name name}))))

(def ui-text-layer (c/factory TextLayer {:keyfn :text-layer/id}))

(defsc TextEditor [this {:document/keys [id name text-layers] :as props}]
  {:query [:document/id :document/name
           {:document/text-layers (c/get-query TextLayer)}]
   :ident :document/id}
  (mui/container {:maxWidth "md"}
    (mui/box {:m 1}
      (mui/alert {:severity "info"}
        "Enter text however you like, with one exception: each sentence (or equivalent) should have one sentence"))
    (if (empty? text-layers)
      (mui/zero-state "No text layers exist.")
      (mapv ui-text-layer text-layers))))

(def ui-text-editor (c/factory TextEditor))