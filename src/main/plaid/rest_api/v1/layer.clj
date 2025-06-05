(ns plaid.rest-api.v1.layer
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.xtdb.project :as prj]))

(defn layer-config-routes [id-keyword]
  ["/config/:editor-name/:config-key"
   {:middleware [[pra/wrap-writer-required #(-> % :parameters :path id-keyword)]]
    :put        {:summary    "Set a configuration value for a layer in a specific editor namespace"
                 :parameters {:path [:map [id-keyword :uuid] [:editor-name string?] [:config-key string?]]
                              :body any?}
                 :handler    (fn [{{{:keys [editor-name config-key] id id-keyword} :path config-value :body} :parameters xtdb :xtdb}]
                               (let [{:keys [success code error]} (prj/assoc-editor-config-pair {:node xtdb} id editor-name config-key config-value)]
                                 (if success
                                   {:status 204}
                                   {:status (or code 400)
                                    :body   {:error error}})))}

    :delete     {:summary    "Remove a configuration value for a layer in a specific editor namespace"
                 :parameters {:path [:map [:id :uuid] [:editor-name string?] [:config-key string?]]}
                 :handler    (fn [{{{:keys [editor-name config-key] id id-keyword} :path} :parameters xtdb :xtdb}]
                               (let [{:keys [success code error]} (prj/dissoc-editor-config-pair {:node xtdb} id editor-name config-key)]
                                 (if success
                                   {:status 204}
                                   {:status (or code 400)
                                    :body   {:error error}})))}}])
