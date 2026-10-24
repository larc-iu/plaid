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
  (:require [taoensso.timbre :as log]
            [plaid.rest-api.v1.auth :as pra]
            [plaid.sql.query.exec :as qe]
            [plaid.sql.token-counts :as token-counts]))

(def query-routes
  [["/query"
    {:post {:summary (str "Run a query over all projects you can read. Returns id tuples (or full entities / a count via :return). "
                          "It writes nothing, so an Idempotency-Key on it is accepted and changes nothing. "
                          "Inside a batch it reads what the batch's earlier operations wrote.")
            :plaid/idempotency :read
            :openapi {:security [{:auth []}]}
            :parameters {:body any?}
            :handler (fn [{db :db user-id :user/id {body :body} :parameters}]
                       (try
                         {:status 200 :body (qe/run db user-id body)}
                         (catch clojure.lang.ExceptionInfo e
                           (let [code (or (:code (ex-data e)) 500)]
                             ;; author-facing codes (400 bad query, 408 timeout,
                             ;; 503 no turn in the heavy-query queue) carry a
                             ;; helpful message and are NOT server bugs;
                             ;; anything else is logged and returned opaque.
                             (if (#{400 408 503} code)
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
                           {:status 500 :body {:error "Internal query error"}})))}}]
   ["/query/token-counts"
    ;; Its own scope check, in place of the query's that the group above
    ;; gives: the body is no query, and the counts read every project the
    ;; user can read, so a scoped token is checked on the layers it names.
    {:plaid/token-scope pra/token-counts-token-scope
     :post {:summary (str "Count, per document, the tokens of each given token layer whose surface matches a regex "
                          "(`value`: {regex, flags?}), as a query's :value regex on a token decides. "
                          "Body {layers: [ids], value: {regex}}. Returns {results: [[layerId, documentId, count]]}, "
                          "a document with tokens of the layer and no match counting 0. Layers you cannot read are left out. "
                          "Each text is read once, so it stays fast on a long document where the query language "
                          "slices every token's surface out of its text. It does not wait for a turn among the large queries, so a full queue of them never refuses it. "
                          "It writes nothing.")
            :plaid/idempotency :read
            :openapi {:security [{:auth []}]}
            :parameters {:body any?}
            :handler (fn [{db :db user-id :user/id {body :body} :parameters}]
                       (try
                         {:status 200
                          :body {:results (token-counts/counts db user-id (:layers body) (:value body))}}
                         (catch clojure.lang.ExceptionInfo e
                           (let [code (or (:code (ex-data e)) 500)]
                             (if (#{400 408} code)
                               {:status code :body {:error (ex-message e)}}
                               (do (log/error e "Token count failed for user" user-id)
                                   {:status 500 :body {:error "Internal error"}}))))))}}]])
