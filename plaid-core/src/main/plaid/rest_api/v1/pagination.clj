(ns plaid.rest-api.v1.pagination
  "REST glue for the uniform paginated list envelope. Decodes the opaque
  `?cursor` (→ clean 400 on garbage, since the read path has no global
  exception-middleware), invokes the fetch fn, and re-encodes the
  `:next-cursor`."
  (:require [plaid.sql.pagination :as pg]))

(def query-params
  "Re-export of the shared ?limit/?cursor malli fragment so route files
  require a single namespace."
  pg/query-params)

(defn list-response
  "Build a ring response for a paginated list endpoint. `query` is the
  coerced `:query` params map (may carry :limit/:cursor). `fetch` takes
  `{:limit n :cursor-vals [...]}` and returns
  `{:entries [...] :next-cursor <raw-vals-or-nil>}`."
  [query fetch]
  (let [cursor-vals (try
                      (pg/decode-cursor (:cursor query))
                      (catch clojure.lang.ExceptionInfo e
                        (if (= 400 (:code (ex-data e)))
                          ::bad-cursor
                          (throw e))))]
    (if (= cursor-vals ::bad-cursor)
      {:status 400 :body {:error "Invalid pagination cursor"}}
      (let [{:keys [entries next-cursor]} (fetch {:limit       (:limit query)
                                                  :cursor-vals cursor-vals})]
        {:status 200
         :body   {:entries     (vec entries)
                  :next-cursor (pg/encode-cursor next-cursor)}}))))
