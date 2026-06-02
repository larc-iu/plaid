(ns plaid.rest-api.v1.query
  "REST surface for the query language: POST /api/v1/query.

  Any authenticated user may call it; access control is enforced *inside* the
  pipeline (the query only ever sees projects the caller can read — see
  `plaid.sql.query.resolve/effective-scope`), so there is no single project to
  gate on at the route. The body is the query AST in JSON form; `plaid.query.ast`
  owns validation and throws `ex-info` with a `:code` we map to the HTTP status."
  (:require [plaid.sql.query.exec :as qe]))

(def query-routes
  [["/query"
    {:post {:summary "Run a query over all projects you can read. Returns id tuples (or full entities / a count via :return)."
            :openapi {:security [{:auth []}]
                      :x-client-method "query"
                      :x-client-bundle "query"}
            :parameters {:body any?}
            :handler (fn [{db :db user-id :user/id {body :body} :parameters}]
                       (try
                         {:status 200 :body (qe/run db user-id body)}
                         (catch clojure.lang.ExceptionInfo e
                           (let [code (or (:code (ex-data e)) 500)]
                             {:status code
                              :body {:error (ex-message e)}}))))}}]])
