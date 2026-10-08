(ns plaid.rest-api.v1.user-data
  "REST surface for private per-user key/value storage: `/users/:user-id/data`.
  The owning user or a global admin may read and write; nobody else can see
  that a key exists. Values are arbitrary JSON, stored and returned verbatim."
  (:require [plaid.rest-api.v1.api-token :as api-token :refer [self-or-admin]]
            [plaid.rest-api.v1.schema :as schema]
            [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.pagination :as pagination]
            [plaid.sql.user-data :as user-data]))

(defn- wrap-own-writes-for-named-tokens
  "Refuse a write to another user's private data when the request is signed
  with a named API token, as an admin's would otherwise be allowed. A token
  writes its own owner's data (Luke, 2026-10-03)."
  [handler]
  (fn [{{{:keys [user-id]} :path} :parameters :as request}]
    (if (and (api-token/named-token? request)
             (not= user-id (pra/->user-id request)))
      api-token/session-only-refusal
      (handler request))))

(def user-data-routes
  ["/users/:user-id/data"
   {:plaid/idempotency false
    :openapi {:security [{:auth []}]}
    :parameters {:path [:map [:user-id schema/user-id]]}
    :middleware [pra/wrap-login-required
                 (self-or-admin "You can only read or change your own private data.")
                 pra/wrap-path-user-required]}

   [""
    {:get {:summary (str "List a user's private data entries ({key, updated-at}), ordered by key "
                         "and narrowed by <query>prefix</query> (the literal head of a key) and/or "
                         "<query>pattern</query>, a GLOB over the whole key (`*` any run, `?` one "
                         "character) for a key convention whose selector is a segment in the middle, "
                         "e.g. `igt:assistant:*:meta:*`. Each entry's value comes with "
                         "<query>include-values</query>, so an unnarrowed listing stays a listing "
                         "of keys.")
           :parameters {:query (into [:map
                                      [:prefix {:optional true} string?]
                                      [:pattern {:optional true} string?]
                                      [:include-values {:optional true} boolean?]]
                                     pagination/query-params)}
           :handler (fn [{{{:keys [user-id]} :path {:keys [prefix pattern include-values] :as query} :query} :parameters db :db}]
                      (pagination/list-response
                       query
                       (fn [opts]
                         (user-data/list db user-id (assoc opts
                                                           :prefix prefix
                                                           :pattern pattern
                                                           :include-values? (true? include-values))))))}}]

   ["/:key"
    {:parameters {:path [:map [:key string?]]}}
    [""
     {:get {:summary "Read one private data entry: {key, updated-at, value}."
            :handler (fn [{{{:keys [user-id key]} :path} :parameters db :db}]
                       (if-let [entry (user-data/get db user-id key)]
                         {:status 200 :body entry}
                         {:status 404 :body {:error "No such entry"}}))}
      :put {:summary (str "Create or replace one private data entry. The body is the value: any JSON "
                          "(object, array, or scalar), up to the size GET /info publishes as "
                          "`userDataValueBytes` (`[user_data] max_value_mb`, 5 MB by default). Not audited. An admin's "
                          "write to another user's data needs a signed-in session: one signed "
                          "with a named API token is refused (403). Every write bumps the "
                          "entry's version, which reads and writes answer. With "
                          "<query>version</query> (the version the writer read, 0 for an entry "
                          "that must not exist yet) the write lands only when the entry is still "
                          "at that version, and is otherwise refused with 409 and the stored "
                          "`version` and `updated-at`.")
            :middleware [wrap-own-writes-for-named-tokens]
            :parameters {:body any?
                         :query [:map [:version {:optional true} [:int {:min 0}]]]}
            :handler (fn [{{{:keys [user-id key]} :path {:keys [version]} :query body :body} :parameters db :db}]
                       (let [{:keys [error current] :as result} (user-data/put! db user-id key body version)]
                         (case error
                           :too-large {:status 413 :body {:error (str "Value exceeds " (user-data/max-value-bytes) " bytes")}}
                           :version-mismatch {:status 409
                                              :body (merge {:error "version-mismatch"} current)}
                           nil {:status 200 :body result})))}
      :delete {:summary (str "Delete one private data entry. An admin's delete of another user's "
                             "entry needs a signed-in session: one signed with a named API token "
                             "is refused (403).")
               :middleware [wrap-own-writes-for-named-tokens]
               :handler (fn [{{{:keys [user-id key]} :path} :parameters db :db}]
                          (if (pos? (user-data/delete! db user-id key))
                            {:status 204}
                            {:status 404 :body {:error "No such entry"}}))}}]]])
