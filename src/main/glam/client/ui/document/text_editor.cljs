(ns glam.client.ui.document.text-editor
  (:require [goog.object :as gobj]
            [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.algorithms.merge :as merge]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]
            [glam.client.router :as r]
            [glam.client.util :as gcu]
            [glam.models.text :as txt]
            [glam.models.token :as tok]
            [glam.models.token-layer :as tokl]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.common.forms :as forms]
            [glam.client.ui.document.common :as dc]
            [glam.algos.text :as ta]
            [taoensso.timbre :as log]
            [glam.client.ui.material-ui-icon :as muic]
            [glam.client.ui.global-snackbar :as snack]
            [glam.client.ui.document.token-editor :refer [Token ui-token]]))

(declare TextEditor)

(m/defmutation morpheme-tokenize [{doc-id :document/id text-id :text/id}]

  (action [{:keys [state ref]}] nil))

(m/defmutation save-text
  [{doc-id :document/id mutation :mutation}]
  (action [{:keys [state ref]}]
          (swap! state #(assoc-in % (conj ref :ui/busy?) true)))
  (remote [{:keys [ast]}]
          (let [ast (assoc ast :key mutation)]
            ast))
  (result-action [{:keys [state ref app component] :as env}]
                 (let [{:server/keys [message error?]} (get-in env [:result :body mutation])]
                   (swap! state (fn [s]
                                  (cond-> (assoc-in s (conj ref :ui/busy?) false)
                                          (not error?) (assoc-in (conj ref :ui/pristine-body)
                                                                 (get-in s (conj ref :text/body)))
                                          (not error?) (assoc-in (conj ref :ui/ops) []))))
                   (when message
                     (snack/message! {:message  message
                                      :severity (if error? "error" "success")}))
                   (df/load! app [:document/id doc-id] TextEditor))))

(m/defmutation create-text
  [{doc-id :document/id mutation :mutation}]
  (action [{:keys [state ref]}]
          (swap! state #(assoc-in % (conj ref :ui/busy?) true)))
  (remote [{:keys [ast]}]
          (let [ast (assoc ast :key mutation)]
            ast))
  (result-action [{:keys [state ref app] :as env}]
                 (let [{:server/keys [message error?]} (get-in env [:result :body mutation])]
                   (swap! state (fn [s]
                                  (cond-> (assoc-in s (conj ref :ui/busy?) false)
                                          (not error?) (assoc-in (conj ref :ui/pristine-body)
                                                                 (get-in s (conj ref :text/body)))
                                          (not error?) (assoc-in (conj ref :ui/ops) []))))
                   (when message
                     (snack/message! {:message  message
                                      :severity (if error? "error" "success")}))
                   (tempid/resolve-tempids! app (get-in env [:result :body]))
                   (df/load! app [:document/id doc-id] TextEditor))))

(defsc Text
  [this
   {:text/keys [id body] :ui/keys [busy? pristine-body ops active-token-layer] :as props}
   {document-id :document/id text-layer-id :text-layer/id token-layers :token-layers}]
  {:query          [:text/id :text/body :ui/busy? :ui/pristine-body :ui/ops :ui/active-token-layer]
   :pre-merge      (fn [{:keys [data-tree]}]
                     ;; TODO: if pristine does not match body, warn user before we clobber their changes
                     (merge {:ui/busy?              false
                             :ui/pristine-body      (:text/body data-tree)
                             :ui/ops                []
                             :ui/active-token-layer ""}
                            data-tree))
   :initLocalState (fn [this _] {:save-ref (fn [r] (gobj/set this "input-ref" r))})
   :ident          :text/id}
  (let [save-ref (c/get-state this :save-ref)
        on-submit (fn [e]
                    (.preventDefault e)
                    (if (tempid/tempid? id)
                      (c/transact! this [(create-text {:text/id       id
                                                       :text-layer/id text-layer-id
                                                       :document/id   document-id
                                                       :body          body
                                                       :mutation      `txt/create-text})])
                      (c/transact! this [(save-text {:text/id       id
                                                     :text-layer/id text-layer-id
                                                     :document/id   document-id
                                                     :old-body      pristine-body
                                                     :new-body      body
                                                     :ops           ops
                                                     :mutation      `txt/save-text})])))

        on-submit-with-morpheme-tokenization (fn [token-layer-id e]
                                               (.preventDefault e)
                                               (if (tempid/tempid? id)
                                                 (c/transact! this [(create-text {:text/id        id
                                                                                  :text-layer/id  text-layer-id
                                                                                  :document/id    document-id
                                                                                  :body           body
                                                                                  :token-layer/id token-layer-id
                                                                                  :mutation       `txt/create-and-morpheme-tokenize})])
                                                 (c/transact! this [(save-text {:text/id        id
                                                                                :text-layer/id  text-layer-id
                                                                                :document/id    document-id
                                                                                :old-body       pristine-body
                                                                                :new-body       body
                                                                                :ops            ops
                                                                                :token-layer/id token-layer-id
                                                                                :mutation       `txt/save-and-morpheme-tokenize})])))
        dirty? (not= body pristine-body)]
    (dom/form {}
      (mui/vertical-grid
        (mui/text-field
          {:inputRef  save-ref
           :multiline true
           :variant   "outlined"
           :fullWidth true
           :value     body
           :disabled  busy?
           :onChange  (fn [e]
                        (let [ref (gobj/get this "input-ref")
                              end-index (.-selectionStart ref)
                              new-body (.-value (.-target e))
                              diff-result (ta/diff body new-body end-index)]
                          (m/set-value!
                            this
                            :ui/ops
                            (into ops diff-result))
                          (m/set-string! this :text/body :event e)))})

        (mui/horizontal-grid
          (mui/button
            {:type      "submit"
             :size      "large"
             :disabled  (or busy? (not dirty?))
             :color     "primary"
             :variant   "contained"
             :startIcon (muic/save)
             :onClick   on-submit}
            "Save")
          (mui/button
            {:size      "large"
             :disabled  (or busy? (not dirty?))
             :variant   "outlined"
             :onClick   (fn []
                          (m/set-value! this :text/body pristine-body)
                          (m/set-value! this :ui/ops []))
             :startIcon (muic/restore)}
            "Discard Changes"))
        (mui/horizontal-grid
          (mapv (fn [{:token-layer/keys [id name]}]
                  (mui/button
                    {:type      "submit"
                     :size      "large"
                     :disabled  (or busy? (not dirty?))
                     :color     "primary"
                     :variant   "contained"
                     :startIcon (muic/more-horiz)
                     :onClick   #(on-submit-with-morpheme-tokenization id %)}
                    (str "Save and Morpheme-Tokenize (" name ")")))
                token-layers))))))

(def ui-text (c/computed-factory Text {:keyfn :text/id}))

;; (defsc Token [this {:token/keys [id begin end]} {:keys [text]}]
;;   {:query [:token/id :token/begin :token/end]
;;    :ident :token/id}
;;   (dc/inline-span (str id) (subs (:text/body text) begin end) true))
;;
;; (def ui-token (c/computed-factory Token {:keyfn :token/id}))

(defsc TokenLayer [this {:token-layer/keys [id name tokens]} {:keys [text]}]
  {:query [:token-layer/id :token-layer/name
           {:token-layer/tokens (c/get-query Token)}]
   :ident :token-layer/id}
  (let [{:keys [tokens text] :as output} (ta/apply-text-edits (:ui/ops text)
                                                              (assoc text :text/body (:ui/pristine-body text))
                                                              tokens)
        tokens-and-strings (ta/add-untokenized-substrings tokens text)]
    (mui/box {:my 2}
      (mui/typography {:component "h6" :gutterBottom true :variant "subtitle1"} name)
      (doall (for [[line-num line] (map-indexed (fn [i l] [i l]) (ta/separate-into-lines tokens-and-strings text))]
               (dom/div (map-indexed (fn [tok-num e] (if (string? e)
                                                       ;; This is bad react practice but we don't have an easy alternative
                                                       (dc/inline-span (str line-num "-" tok-num) e false)
                                                       (ui-token (c/computed e {:text text}))))
                                     line)))))))

(def ui-token-layer (c/computed-factory TokenLayer {:keyfn :token-layer/id}))

(defsc TextLayer
  [this {:text-layer/keys [id name text token-layers]} {document-id :document/id}]
  {:query     [:text-layer/name :text-layer/id
               {:text-layer/text (c/get-query Text)}
               {:text-layer/token-layers (c/get-query TokenLayer)}]
   :pre-merge (fn [{:keys [data-tree query current-normalized]}]
                ;; If we don't have a text, make a tempid and chug along
                (merge
                  (if (merge/not-found? data-tree :text-layer/text)
                    (assoc data-tree :text-layer/text {:text/id   (tempid/tempid)
                                                       :text/body ""})
                    data-tree)))
   :ident     :text-layer/id}
  (dom/div
    (mui/box {:my 3}
      (mui/typography {:component "h4" :gutterBottom true :variant "h4"} name)
      (mui/box {:my 2}
        (mui/typography {:component "h5" :gutterBottom true :variant "h5"} "Token Preview "
                        (mui/tooltip {:interactive true
                                      :title       "This display-only area shows how tokens are affected by changes you
                                                  make to text. To edit tokens, go to the Tokens tab."}
                          (muic/help-outline-outlined {:color "secondary" :fontSize "small"})))
        (mapv ui-token-layer (map #(c/computed % {:text text})
                                  token-layers)))
      (mui/box {:my 2}
        (mui/typography {:component "h5" :gutterBottom true :variant "h5"} "Text Edit "
                        (mui/tooltip {:interactive true
                                      :title       "Enter text however you like, with one exception: each sentence
                                                  (or equivalent) should have one line. Also note that currently
                                                  only whitespace tokenization is supported (this will change soon)."}
                          (muic/help-outline-outlined {:color "secondary" :fontSize "small"})))
        (ui-text (c/computed text {:text-layer/name name
                                   :text-layer/id   id
                                   :document/id     document-id
                                   :token-layers    (mapv #(select-keys % [:token-layer/id :token-layer/name]) token-layers)}))))))

(def ui-text-layer (c/computed-factory TextLayer {:keyfn :text-layer/id}))

(defsc TextEditor [this {:document/keys [id name text-layers] :as props}]
  {:query [:document/id :document/name
           {:document/text-layers (c/get-query TextLayer)}]
   :ident :document/id}
  (mui/container {:maxWidth "md"}
    (if (empty? text-layers)
      (mui/zero-state "No text layers exist.")
      (mapv ui-text-layer (map #(c/computed % {:document/id id}) text-layers)))))

(def ui-text-editor (c/factory TextEditor))