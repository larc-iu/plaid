(ns glam.client.ui.document.token-editor
  (:require [goog.object :as gobj]
            [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.algorithms.merge :as merge]
            [com.fulcrologic.fulcro.algorithms.normalized-state :as norms]
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
          (let [ast (assoc ast :key `tokl/whitespace-tokenize)]
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
            (-> ast
                (assoc :key `tok/set-extent)
                (update :params dissoc :delta)
                (update :params dissoc :direction)
                (update :params assoc (keyword (str "delta-" (name direction))) delta))))
  (ok-action [{:keys [state ref]}]
             nil)
  (error-action [{:keys [state ref]}]
                (swap! state #(update-in % (conj ref :token/begin) (fn [v] (- v delta))))))

(m/defmutation delete-token [{token-id :token/id}]
  (action [{:keys [state ref]}]
          (swap! state #(norms/remove-entity % ref)))
  (remote [{:keys [ast]}]
          (-> ast
              (assoc :key `tok/delete)))
  (ok-action [{:keys [state ref]}]
             (log/info "Deleted"))
  (error-action [{:keys [state ref]}]
                nil))

(m/defmutation create-token [token]
  (action [{:keys [state ref]}]
          (swap! state (fn [s]
                         (-> s
                             (assoc-in [:token/id (:token/id token)] token)
                             (update-in [:token-layer/id (:token/layer token) :token-layer/tokens]
                                        conj [:token/id (:token/id token)])))))
  (remote [{:keys [ast]}]
          (-> ast
              (assoc :key `tok/create)))
  (ok-action [{:keys [result app]}]
             (tempid/resolve-tempids! app (:body result)))
  (error-action [{:keys [state ref]}]
                (swap! state (fn [s] (-> s
                                         (update :token/id dissoc (:token/id token))
                                         (update-in [:token-layer/id (:token/layer token) :token-layer/tokens]
                                                    (fn [tokens] (filterv #(not= (second %) (:token/id token)) tokens))))))))

(defsc Text
  [this {:text/keys [id body] :as props}]
  {:query [:text/id :text/body]
   :ident :text/id})

(defsc Token [this {:token/keys [id begin end] focused? :ui/focused? :as props} {:keys [text]}]
  {:query          [:token/id :token/begin :token/end :ui/focused?]
   :ident          :token/id
   :initLocalState (fn [this _]
                     {:save-ref (fn [r]
                                  (gobj/set this "ref" r))})}
  (let [save-ref (c/get-state this :save-ref)]
    (dc/base-inline-span
      {:onMouseEnter (fn [_]
                       (.focus (gobj/get this "ref"))
                       (m/set-value! this :ui/focused? true))
       :onMouseLeave (fn [_]
                       (m/set-value! this :ui/focused? false))
       :onMouseDown  #(c/transact! this [(delete-token {:token/id    id
                                                        :token/begin begin
                                                        :token/end   end
                                                        :token/layer (:token/layer props)
                                                        :token/text  (:token/text props)})])
       :onKeyDown    (fn [e]
                       (let [shift (.-shiftKey e)
                             key (.-key e)
                             left-keys #{"a" "A" "ArrowLeft"}
                             right-keys #{"d" "D" "ArrowRight"}]
                         (cond (and shift (left-keys key))
                               (c/transact! this [(shift-token {:token/id id :direction :end :delta -1})])

                               (left-keys key)
                               (c/transact! this [(shift-token {:token/id id :direction :begin :delta -1})])

                               (and shift (right-keys key))
                               (c/transact! this [(shift-token {:token/id id :direction :begin :delta 1})])

                               (right-keys key)
                               (c/transact! this [(shift-token {:token/id id :direction :end :delta 1})]))))
       :ref          save-ref
       ;; Need a tab index for focus to work, and need focus to work for logging keyboard events
       :tabIndex     begin}
      (cond-> {:borderRadius "3px"
               :border       "1px solid black"}
              focused? (merge {:backgroundColor "#e3ffe6"
                               :cursor          "not-allowed"}))
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
                                                        " boundaries with the following key combinations: "
                                                        "(1) Expand left: A or ←; "
                                                        "(2) Shrink right: SHIFT+A or SHIFT+←; "
                                                        "(3) Expand right: D or →; "
                                                        "(4) Shrink left: SHIFT+D or SHIFT+→"
                                                        )}
                          (muic/help-outline-outlined {:color "secondary" :fontSize "small"})))
        (dom/div {:onMouseUp (fn [e]
                               (let [s (js/window.getSelection)
                                     n (.-parentNode (.-baseNode s))
                                     row (.-parentNode n)]
                                 (when (and (not (.-isCollapsed s))
                                            (= (.-anchorNode s) (.-baseNode s) (.-extentNode s)))
                                   (let [row-length (loop [sibling (.-previousSibling n)
                                                           length 0]
                                                      (if (nil? sibling)
                                                        length
                                                        (recur (.-previousSibling sibling)
                                                               (+ length (count (.-innerText sibling))))))
                                         prev-row-length (loop [prev-row (.-previousSibling row)
                                                                length 0]
                                                           (if (nil? prev-row)
                                                             length
                                                             (recur (.-previousSibling prev-row)
                                                                    ;; 1 to account for \n
                                                                    (+ length 1 (count (.-innerText prev-row))))))
                                         offset (+ row-length prev-row-length)
                                         begin (+ offset (min (.-baseOffset s) (.-extentOffset s)))
                                         end (+ offset (max (.-baseOffset s) (.-extentOffset s)))
                                         new-token-record {:token/begin begin
                                                           :token/end   end
                                                           :token/id    (tempid/tempid)
                                                           :token/layer id
                                                           :token/text  (:text/id text)}]
                                     (c/transact! this [(create-token new-token-record)])))))}
          (for [[line-num line] (map-indexed (fn [i l] [i l]) (ta/separate-into-lines tokens-and-strings text))]
            (dom/div {}
              (map-indexed (fn [tok-num e] (if (string? e)
                                             ;; TODO: is this key strategy ok?
                                             (dc/inline-span (str line-num "-" tok-num) e false)
                                             (ui-token (c/computed e {:text text}))))
                           line))))
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
