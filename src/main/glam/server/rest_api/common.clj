(ns glam.server.rest-api.common
  (:require [glam.models.project :as prj]
            [glam.server.id-counter :refer [id?]]
            [malli.experimental.lite :as ml]))

(def layer-schema-query
  [:text-layer/id :text-layer/name :config
   {:text-layer/token-layers
    [:token-layer/id :token-layer/name :config
     {:token-layer/span-layers
      [:span-layer/id :span-layer/name :config
       {:span-layer/relation-layers
        [:relation-layer/id :relation-layer/name :config]}]}]}])

;; This should be kept in lock-step with the output of glam.models.document/get-full-document
(def document-body-query
  {:document/text-layers
   [:text-layer/id :text-layer/name :config
    {:text-layer/text [:text/id :text/body]}
    {:text-layer/token-layers
     [:token-layer/id :token-layer/name :config
      {:token-layer/tokens [:token/id :token/begin :token/end :token/text]}
      {:token-layer/span-layers
       [:span-layer/id :span-layer/name :config
        {:span-layer/spans [:span/id :span/value :span/tokens]}
        {:span-layer/relation-layers
         [:relation-layer/id :relation-layer/name :config
          {:relation-layer/relations [:relation/id :relation/source :relation/target :relation/value]}]}]}]}]})

(defn patch-config [{{{:keys [id]} :path
                      {:keys [action editorName key value]} :body} :parameters
                     parser :pathom-parser :as req}]
  (let [action-symbol ({"set"    `prj/set-editor-config-pair
                        "delete" `prj/delete-editor-config-pair} action)
        action-params ({"set"    {:layer-id id :editor-name editorName :config-key key :config-value value}
                        "delete" {:layer-id id :editor-name editorName :config-key key}} action)]
    (let [result (parser req [(list action-symbol action-params)])
          data (get result action-symbol)]
      (if (:server/error? data)
        {:status 400
         :body   data}
        {:status 200
         :body   data}))))
(def config-fragment ["/config"
                      {:patch {:handler     patch-config
                               :description (str "Modify a layer (`id`)'s config. `action` is \"set\" or \"delete\". "
                                                 "`editorName` is the key to put the key-value pair under. `key` is the "
                                                 "key that is associated with the `value` under `editorName`. `value` is "
                                                 "optional if `action` is \"delete\".")
                               :parameters  {:path {:id id?}
                                             :body {:action     [:enum "set" "delete"]
                                                    :editorName string?
                                                    :key        string?
                                                    :value      (ml/optional string?)}}}}])
