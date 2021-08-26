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
            [glam.models.text :as txt]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.common.forms :as forms]
            [taoensso.timbre :as log]
            [glam.client.ui.material-ui-icon :as muic]
            [glam.client.ui.global-snackbar :as snack]))

;; TODO: this is display only for now, make full stack

(m/defmutation save-text
  [params]
  (action [{:keys [state ref]}]
          (swap! state #(assoc-in % (conj ref :ui/busy?) true)))
  (remote [{:keys [ast]}]
          (let [ast (assoc ast :key `txt/save-text)]
            ast))
  (result-action [{:keys [state ref app] :as env}]
                 (let [{:server/keys [message error?]} (get-in env [:result :body `txt/save-text])]
                   (swap! state (fn [s]
                                  (cond-> (assoc-in s (conj ref :ui/busy?) false)
                                          (not error?) (assoc-in (conj ref :ui/pristine-body)
                                                                 (get-in s (conj ref :text/body))))))
                   (when message
                     (snack/message! {:message  message
                                      :severity (if error? "error" "success")}))
                   (tempid/resolve-tempids! app (get-in env [:result :body])))))

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
  (let [dirty? (not= pristine-body body)
        on-submit (fn [e]
                    (.preventDefault e)
                    (c/transact! this [(save-text {:text/id       id
                                                   :text-layer/id text-layer-id
                                                   :document/id   document-id
                                                   :new-body      body
                                                   :old-body      pristine-body})]))]
    (dom/form {:onSubmit on-submit}
              (mui/vertical-grid
                (mui/text-field
                  {:multiline true
                   :variant   "outlined"
                   :fullWidth true
                   :label     text-layer-name
                   :value     body
                   :disabled  busy?
                   :onChange  #(m/set-string! this :text/body :event %)
                   :onPaste   (fn [e]
                                (if (< 0 (count (.toString (js/window.getSelection))))
                                  (do
                                    (js/alert (str "Pasting while text is selected is not supported. "
                                                   "Please unselect the text and try pasting again."))
                                    (.preventDefault e))
                                  (do
                                    ;;apparently don't need anything here
                                    )))})

                (mui/horizontal-grid
                  (mui/button
                    {:type      "submit"
                     :size      "large"
                     :disabled  (or busy? (not dirty?))
                     :color     "primary"
                     :variant   "contained"
                     :startIcon (muic/save)}
                    "Save Changes")
                  (mui/button
                    {:size      "large"
                     :disabled  (or busy? (not dirty?))
                     :variant   "outlined"
                     :onClick   (fn []
                                  (m/set-string! this :text/body :value pristine-body))
                     :startIcon (muic/restore)}
                    "Discard Changes"))))))

(def ui-text (c/computed-factory Text {:keyfn :text/id}))

(defsc TextLayer
  [this {:text-layer/keys [id name text]} {document-id :document/id}]
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
    (ui-text (c/computed text {:text-layer/name name
                               :text-layer/id   id
                               :document/id     document-id}))))

(def ui-text-layer (c/computed-factory TextLayer {:keyfn :text-layer/id}))

(defsc TextEditor [this {:document/keys [id name text-layers] :as props}]
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

(def ui-text-editor (c/factory TextEditor))