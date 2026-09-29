(ns plaid.rest-api.v1.client-event
  "REST surface for client events, the opt-in research telemetry. See
  `plaid.sql.client-event` for the switch, the closed set of types and why
  this sits outside the audit log.

  Writing takes a project WRITE, the standing of the people whose use of
  suggestions is being recorded. Reading takes MAINTAINER (or admin): the
  events are about how each person works, which is more than a fellow
  annotator needs to see."
  (:require [clojure.string]
            [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.pagination :as pagination]
            [plaid.sql.client-event :as ce])
  (:import (java.time Instant)
           (java.time.format DateTimeParseException)))

(defn- project-id [{params :parameters}]
  (-> params :path :id))

;; Same parsing as the audit log's window: an Instant with every digit given.
(def ^:private instant-param
  [:fn {:decode/string (fn [x]
                         (if (string? x)
                           (try (Instant/parse x) (catch DateTimeParseException _ x))
                           x))
        :error/message "should be an ISO-8601 instant, e.g. 2026-05-28T09:00:00Z"
        :json-schema/type "string"
        :json-schema/format "date-time"}
   #(instance? Instant %)])

(def ^:private list-query-params
  (into [:map
         [:types {:optional true} string?]
         [:start-time {:optional true} instant-param]
         [:end-time {:optional true} instant-param]]
        pagination/query-params))

(defn- parse-types
  "Split `?types=`. Returns `{:types [...]}` (nil for no filter) or
  `{:invalid t}` for a type outside the set, which is a 400 rather than an
  empty page that would read as \"nothing happened\"."
  [raw]
  (if-let [raw (not-empty (some-> raw clojure.string/trim))]
    (let [tokens (->> (clojure.string/split raw #",")
                      (map clojure.string/trim)
                      (remove empty?)
                      distinct
                      vec)]
      (if-let [bad (first (remove ce/types tokens))]
        {:invalid bad}
        {:types (not-empty tokens)}))
    {:types nil}))

(def ^:private types-doc
  (clojure.string/join ", " (sort ce/types)))

(defn- error-response [e]
  {:status (or (:code (ex-data e)) 500)
   :body {:error (ex-message e)}})

(def client-event-routes
  [["/projects/:id/events"
    {:openapi {:security [{:auth []}]}
     :parameters {:path [:map [:id :uuid]]}
     :post {:summary (str "Record client events (research telemetry). The body is an array of at most "
                          ce/max-events-per-request " events, each "
                          "<code>{type, document-id?, target-id?, data?, client-ts?}</code>. "
                          "<code>type</code> is one of " types-doc ". <code>data</code> holds only "
                          "the keys of its type (value, source and field for a suggestion, plus written "
                          "when dismissed, conversation for plan.opened), each a string of at most "
                          ce/max-data-value-length " characters or a number. "
                          "Refused with 403 unless the project's config holds "
                          "<code>plaid.research.telemetry = true</code>. Requires write access; "
                          "the user and the time are stamped by the server. All or nothing: one "
                          "bad event refuses the request with a 400 naming it. Not audited, and "
                          "no document version changes.")
            :middleware [[pra/wrap-writer-required project-id]]
            :parameters {:body [:sequential any?]}
            :handler (fn [{{{:keys [id]} :path body :body} :parameters db :db user-id :user/id}]
                       (try
                         {:status 201 :body {:count (ce/record! db id user-id body)}}
                         (catch clojure.lang.ExceptionInfo e
                           (error-response e))))}
     :get {:summary (str "List a project's client events in arrival order; keyset-paginated. "
                         "Narrow with <query>types</query> (comma-separated, from " types-doc
                         ") and with <query>start-time</query> / <query>end-time</query> "
                         "(ISO-8601, inclusive, on the server's time). Requires maintainer "
                         "access.")
           :middleware [[pra/wrap-maintainer-required project-id]]
           :parameters {:query list-query-params}
           :handler (fn [{{{:keys [id]} :path query :query} :parameters db :db}]
                      (let [{:keys [invalid types]} (parse-types (:types query))]
                        (if invalid
                          {:status 400
                           :body {:error (str "Unknown event type " (pr-str invalid) ". Types: " types-doc)}}
                          (pagination/list-response
                           query
                           (fn [opts]
                             (ce/list db id (assoc opts
                                                   :types types
                                                   :start-time (:start-time query)
                                                   :end-time (:end-time query))))))))}}]])
