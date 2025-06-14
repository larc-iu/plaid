(ns plaid.rest-api.v1.layer
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.xtdb.project :as prj]))

(defn layer-config-routes [id-keyword]
  ["/config/:namespace/:config-key"
   {:middleware [[pra/wrap-writer-required #(-> % :parameters :path id-keyword)]]
    :put        {:summary    (str "Set a configuration value for a layer in a editor namespace. Intended for storing "
                                  "metadata about how the layer is intended to be used, e.g. for morpheme tokenization "
                                  "or sentence boundary marking.")
                 :parameters {:path [:map [id-keyword :uuid] [:namespace string?] [:config-key string?]]
                              :body any?}
                 :handler    (fn [{{{:keys [namespace config-key] id id-keyword} :path config-value :body} :parameters xtdb :xtdb}]
                               (let [{:keys [success code error]} (prj/assoc-editor-config-pair {:node xtdb} id namespace config-key config-value)]
                                 (if success
                                   {:status 204}
                                   {:status (or code 400)
                                    :body   {:error error}})))}

    :delete     {:summary    "Remove a configuration value for a layer."
                 :parameters {:path [:map [:id :uuid] [:namespace string?] [:config-key string?]]}
                 :handler    (fn [{{{:keys [namespace config-key] id id-keyword} :path} :parameters xtdb :xtdb}]
                               (let [{:keys [success code error]} (prj/dissoc-editor-config-pair {:node xtdb} id namespace config-key)]
                                 (if success
                                   {:status 204}
                                   {:status (or code 400)
                                    :body   {:error error}})))}}])
