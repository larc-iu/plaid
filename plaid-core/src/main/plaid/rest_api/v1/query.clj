(ns plaid.rest-api.v1.query
  "REST surface for the query language: POST /api/v1/query.

  Any authenticated user may call it; access control is enforced *inside* the
  pipeline (the query only ever sees projects the caller can read — see
  `plaid.sql.query.resolve/effective-scope`), so there is no single project to
  gate on at the route. The body is the query AST in JSON form; `plaid.query.ast`
  owns validation and throws `ex-info` with a `:code` we map to the HTTP status.
  Author errors (`:code` 400) are returned verbatim; anything else (a compiler
  invariant failure, a SQL/DB error) is logged server-side and returned as a
  generic 500 so internal SQL/exception text never leaks to the caller."
  (:require [clojure.tools.logging :as log]
            [plaid.sql.query.exec :as qe]))

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
                             ;; author-facing codes (400 bad query, 408 timeout)
                             ;; carry a helpful message and are NOT server bugs;
                             ;; anything else is logged and returned opaque.
                             (if (#{400 408} code)
                               {:status code :body {:error (ex-message e)}}
                               (do (log/error e "Query failed for user" user-id)
                                   {:status code :body {:error "Internal query error"}}))))
                         ;; Throwable, not Exception: a deeply-nested query body
                         ;; can recurse to a StackOverflowError (an Error), which
                         ;; would otherwise escape uncaught and bypass this 500
                         ;; envelope. Parse caps nesting depth too, but catch
                         ;; defensively so no internal Error ever reaches the wire.
                         (catch Throwable e
                           (log/error e "Query failed for user" user-id)
                           {:status 500 :body {:error "Internal query error"}})))}}]])
