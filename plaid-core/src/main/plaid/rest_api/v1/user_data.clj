(ns plaid.rest-api.v1.user-data
  "REST surface for private per-user key/value storage: `/users/:user-id/data`.
  The owning user or a global admin may read and write; nobody else can see
  that a key exists. Values are arbitrary JSON, stored and returned verbatim."
  (:require [plaid.rest-api.v1.api-token :refer [wrap-self-or-admin]]
            [plaid.rest-api.v1.auth :as pra]
            [plaid.sql.user-data :as user-data]))

(def user-data-routes
  ["/users/:user-id/data"
   {:openapi {:security [{:auth []}]}
    :parameters {:path [:map [:user-id string?]]}
    :middleware [pra/wrap-login-required wrap-self-or-admin]}

   [""
    {:get {:summary (str "List a user's private data entries ({key, updated-at}), optionally only those "
                         "whose key starts with <query>prefix</query>, and with each entry's value when "
                         "<query>include-values</query> is true.")
           :parameters {:query [:map
                                [:prefix {:optional true} string?]
                                [:include-values {:optional true} boolean?]]}
           :handler (fn [{{{:keys [user-id]} :path {:keys [prefix include-values]} :query} :parameters db :db}]
                      {:status 200
                       :body (user-data/list db user-id {:prefix prefix :include-values? (true? include-values)})})}}]

   ["/:key"
    {:parameters {:path [:map [:key string?]]}}
    [""
     {:get {:summary "Read one private data entry: {key, updated-at, value}."
            :handler (fn [{{{:keys [user-id key]} :path} :parameters db :db}]
                       (if-let [entry (user-data/get db user-id key)]
                         {:status 200 :body entry}
                         {:status 404 :body {:error "No such entry"}}))}
      :put {:summary (str "Create or replace one private data entry. The body is the value: any JSON "
                          "(object, array, or scalar), up to 1 MB. Not audited.")
            :parameters {:body any?}
            :handler (fn [{{{:keys [user-id key]} :path body :body} :parameters db :db}]
                       (let [{:keys [error] :as result} (user-data/put! db user-id key body)]
                         (case error
                           :too-large {:status 413 :body {:error (str "Value exceeds " user-data/max-value-bytes " bytes")}}
                           nil {:status 200 :body result})))}
      :delete {:summary "Delete one private data entry."
               :handler (fn [{{{:keys [user-id key]} :path} :parameters db :db}]
                          (if (pos? (user-data/delete! db user-id key))
                            {:status 204}
                            {:status 404 :body {:error "No such entry"}}))}}]]])
