(ns glam.client.ui.document.token-editor
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
            [glam.algos.text :as ta]
            [taoensso.timbre :as log]
            [glam.client.ui.material-ui-icon :as muic]
            [glam.client.ui.global-snackbar :as snack]
            [glam.client.ui.document.common :as dc]))

(declare TokenEditor)
(m/defmutation whitespace-tokenize
  [{doc-id :document/id :as params}]
  (action [{:keys [state ref]}]
          (swap! state #(assoc-in % (conj ref :ui/busy?) true)))
  (remote [{:keys [ast]}]
          (log/info ast)
          (let [ast (assoc ast :key `tokl/whitespace-tokenize)]
            (log/info ast)
            ast))
  (result-action [{:keys [state ref app] :as env}]
                 (let [{:server/keys [message error?]} (get-in env [:result :body `tokl/whitespace-tokenize])]
                   (swap! state (fn [s]
                                  (assoc-in s (conj ref :ui/busy?) false)))
                   (log/info message)
                   (when message
                     (snack/message! {:message  message
                                      :severity (if error? "error" "success")}))
                   ;; we may need new token offsets--trigger a load
                   (df/load! app [:document/id doc-id] TokenEditor))))

;; :direction is either :begin or :end
(m/defmutation shift-token [{token-id :token/id delta :delta direction :direction :as params}]
  (action [{:keys [state ref]}]
          (when (#{:begin :end} direction)
            (swap! state #(update-in % (conj ref (keyword "token" (name direction))) (fn [v] (+ v delta))))))
  (remote [{:keys [ast]}]
          (when (#{:begin :end} direction)
            (log/info (:params ast))
            (-> ast
                (assoc :key `tok/set-extent)
                (update :params dissoc :delta)
                (update :params dissoc :direction)
                (update :params assoc (keyword (str "delta-" (name direction))) delta))))
  (ok-action [{:keys [state ref]}]
             (log/info "OK"))
  (error-action [{:keys [state ref]}]
                (log/info "oops")
                (swap! state #(update-in % (conj ref :token/begin) (fn [v] (- v delta))))))

(defsc Text
  [this {:text/keys [id body] :as props}]
  {:query [:text/id :text/body]
   :ident :text/id})

(defsc Token [this {:token/keys [id begin end] focused? :ui/focused?} {:keys [text]}]
  {:query          [:token/id :token/begin :token/end :ui/focused?]
   :ident          :token/id
   :initLocalState (fn [this _]
                     {:save-ref (fn [r]
                                  (log/info "Saving ref")
                                  (gobj/set this "ref" r))})}
  (let [save-ref (c/get-state this :save-ref)]
    (dc/base-inline-span
      {:onMouseEnter (fn [_]
                       (.focus (gobj/get this "ref"))
                       (m/set-value! this :ui/focused? true)
                       #_(set-selected-token id))
       :onMouseLeave (fn [_]
                       (m/set-value! this :ui/focused? false)
                       #_(set-selected-token nil))
       :onKeyDown    (fn [e]
                       (let [shift (.-shiftKey e)
                             key (.-key e)
                             left-keys #{"a" "A" "ArrowLeft"}
                             right-keys #{"d" "D" "ArrowRight"}]
                         (log/info key)
                         (log/info shift)
                         (log/info (left-keys key))
                         (cond (and shift (left-keys key))
                               (c/transact! this [(shift-token {:token/id id :direction :begin :delta 1})])

                               (left-keys key)
                               (c/transact! this [(shift-token {:token/id id :direction :begin :delta -1})])

                               (and shift (right-keys key))
                               (c/transact! this [(shift-token {:token/id id :direction :end :delta -1})])

                               (right-keys key)
                               (c/transact! this [(shift-token {:token/id id :direction :end :delta 1})]))))
       :ref          save-ref
       ;; Need a tab index for focus to work, and need focus to work for logging keyboard events
       :tabIndex     begin}
      (cond-> {:borderRadius "3px"
               :border       "1px solid black"}
              focused? (merge {:backgroundColor "#e3ffe6"}))
      (subs (:text/body text) begin end))))

(def ui-token (c/computed-factory Token {:keyfn :token/id}))

(defsc TokenLayer [this {:token-layer/keys [id name tokens] :ui/keys [busy?]} {:keys [text] doc-id :document/id}]
  {:query     [:token-layer/id :token-layer/name
               {:token-layer/tokens (c/get-query Token)}
               :ui/busy?]
   :pre-merge (fn [{:keys [data-tree]}]
                (merge {:ui/busy? false}
                       data-tree))
   :ident     :token-layer/id}
  (let [tokens-and-strings (ta/add-untokenized-substrings tokens text)
        on-submit (fn [e]
                    (.preventDefault e)
                    (c/transact! this [(whitespace-tokenize {:document/id    doc-id
                                                             :text/id        (:text/id text)
                                                             :token-layer/id id})]))]
    (mui/box {:my 2}
      (dom/form {:onSubmit on-submit}
        (mui/typography {:key "title" :component "h6" :gutterBottom true :variant "subtitle1"}
                        name
                        " "
                        (mui/tooltip {:interactive true
                                      :title       (str "To edit individual tokens, hover over it with your mouse and shift its"
                                                        " boundaries with the following key combinations:"
                                                        "(1) Expand left: A or ←; "
                                                        "(2) Shrink left: SHIFT+A or SHIFT+←; "
                                                        "(3) Expand right: D or →; "
                                                        "(4) Shrink right: SHIFT+D or SHIFT+→"
                                                        )}
                          (muic/help-outline-outlined {:color "secondary" :fontSize "small"}))
                        )
        (for [[line-num line] (map-indexed (fn [i l] [i l]) (ta/separate-into-lines tokens-and-strings text))]
          (dom/div (map-indexed (fn [tok-num e] (if (string? e)
                                                  ;; This is bad react practice but we don't have an easy alternative
                                                  (dc/inline-span (str line-num "-" tok-num) e false)
                                                  (ui-token (c/computed e {:text text}))))
                                line)))
        (mui/button
          {:key       "tokenize-button"
           :type      "submit"
           :size      "large"
           :disabled  busy?
           :color     "primary"
           :variant   "outlined"
           :startIcon (muic/more-horiz)
           :style     {:marginTop "0.3em"}}
          "Whitespace Tokenize")))))

(def ui-token-layer (c/computed-factory TokenLayer {:keyfn :token-layer/id}))

(defsc TextLayer
  [this {:text-layer/keys [id name text token-layers]} {document-id :document/id}]
  {:query     [:text-layer/name :text-layer/id
               {:text-layer/text (c/get-query Text)}
               {:text-layer/token-layers (c/get-query TokenLayer)}]
   :pre-merge (fn [{:keys [data-tree]}]
                ;; If we don't have a text, make a tempid and chug along
                (merge
                  (if (merge/not-found? data-tree :text-layer/text)
                    (assoc data-tree :text-layer/text {:text/id   (tempid/tempid)
                                                       :text/body ""})
                    data-tree)))
   :ident     :text-layer/id}
  (dom/div {}
    (mui/typography {:component "h4" :gutterBottom true :variant "h4"} name)
    (if (empty? token-layers)
      (mui/zero-state "No token layers")
      (mui/box {:my 2}
        (mui/typography {:component "h5" :gutterBottom true :variant "h5"} "Token Preview ")
        (mapv ui-token-layer (map #(c/computed % {:text text :document/id document-id})
                                  token-layers))))))

(def ui-text-layer (c/computed-factory TextLayer {:keyfn :text-layer/id}))

(defsc TokenEditor [this {:document/keys [id name text-layers] :as props}]
  {:query [:document/id :document/name
           {:document/text-layers (c/get-query TextLayer)}]
   :ident :document/id}
  (mui/container {:maxWidth "md"}
    (if (empty? text-layers)
      (mui/zero-state "No text layers exist.")
      (mapv ui-text-layer (map #(c/computed % {:document/id id})
                               text-layers)))))

(def ui-token-editor (c/factory TokenEditor))
