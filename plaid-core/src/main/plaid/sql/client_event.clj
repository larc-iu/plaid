(ns plaid.sql.client-event
  "Client events: what a person did with a machine suggestion in an app,
  recorded for a research study of how people work with agent output, and
  only in a project that has switched it on.

  The whole design follows from three rules.

    * OFF MEANS OFF. A project records nothing unless its config holds
      `plaid.research.telemetry = true`, and a write to a project without it
      is refused (`enabled?`), so an app that still sends is not recorded.
    * A CLOSED SET. `types` is every event there is. Anything else is
      refused, so the table cannot grow into a log of keystrokes, clicks or
      focus that nobody agreed to. The same holds for `data`: each type
      takes only its own keys (`data-keys`), each a short string or a number.
    * OUTSIDE THE RECORD. Like comments and user data, writes are raw
      inserts, not operations: no audit rows, no document version bump,
      nothing time-travelable. See the migration
      `20260929120000-client-events.up.sql` for the table and its cascades.

  `user_id` and `ts` are stamped by the server, never read off the body."
  (:require [clojure.data.json :as json]
            [clojure.string]
            [plaid.sql.common :as psc]
            [plaid.sql.pagination :as pg]
            [plaid.util.codepoint :as cp]
            [plaid.util.storable-text :as storable])
  (:refer-clojure :exclude [list]))

(def types
  "Every event type there is.

    suggestion.shown     a machine suggestion became visible (an igt guess)
    suggestion.adopted   it was taken as it was
    suggestion.dismissed it was rejected, or a different value was written
                         where it showed
    plan.opened          an assistant plan card was expanded"
  #{"suggestion.shown" "suggestion.adopted" "suggestion.dismissed" "plan.opened"})

(def data-keys
  "The `data` keys each type may carry, and nothing else: this is what keeps
  \"nothing else is recorded\" on the server rather than only in the apps.

    value        the suggested value
    source       the producer of the suggestion (a rule's or a model's name)
    field        the field it was suggested for
    written      the value written instead (`suggestion.dismissed` only)
    conversation the assistant conversation (`plan.opened` only)"
  {"suggestion.shown"     #{"value" "source" "field"}
   "suggestion.adopted"   #{"value" "source" "field"}
   "suggestion.dismissed" #{"value" "source" "field" "written"}
   "plan.opened"          #{"conversation"}})

(def ^:const max-data-value-length
  "Ceiling on one `data` value, in code points: a gloss, a name or an id,
  never prose. The browser recorder cuts values to this length."
  200)

(def ^:const max-events-per-request
  "Ceiling on one POST. The browser recorder flushes at 50, so this is room
  for a backlog, not a bulk-load path."
  500)

(def ^:const max-target-id-length
  "Ceiling on `target_id`, in code points. An id, never prose."
  200)

(def ^:const max-client-ts-length
  "Ceiling on `client_ts`, an ISO-8601 instant as the browser wrote it."
  64)

;; ============================================================
;; The switch
;; ============================================================

(defn enabled?
  "Is telemetry switched on for `project-id`? True only for a literal
  `true` at `config.plaid.research.telemetry`: a missing key, a string or
  any other value is off."
  [db project-id]
  (let [row (psc/q1 db {:select [:config] :from [:projects] :where [:= :id project-id]})]
    (true? (get-in (psc/parse-config (:config row)) ["plaid" "research" "telemetry"]))))

;; ============================================================
;; Reads
;; ============================================================

(defn- row->event [row]
  (when row
    {:client-event/id          (:id row)
     :client-event/project-id  (:project_id row)
     :client-event/document-id (:document_id row)
     :client-event/user-id     (:user_id row)
     :client-event/type        (:type row)
     :client-event/target-id   (some-> (:target_id row) str)
     :client-event/data        (some-> (:data row) json/read-str)
     :client-event/client-ts   (:client_ts row)
     :client-event/ts          (:ts row)}))

(defn list
  "One page of `project-id`'s events in arrival order, optionally narrowed
  to some `:types` and to a time window on the server's `ts`
  (`:start-time`/`:end-time`, Instants or ISO strings, both inclusive).

  Pages by the integer `id` alone, which is unique and grows with arrival.
  The cursor carries it as a string, and SQLite compares a string against
  an INTEGER column as a number, so page 10 follows page 9."
  [db project-id {:keys [types start-time end-time limit cursor-vals]}]
  (let [->iso (fn [x] (cond
                        (nil? x) nil
                        (string? x) (psc/instant->iso (java.time.Instant/parse x))
                        :else (psc/instant->iso x)))
        from (->iso start-time)
        to (->iso end-time)
        where (cond-> [:and [:= :project_id project-id]]
                (seq types) (conj [:in :type (vec types)])
                from (conj [:>= :ts from])
                to (conj [:<= :ts to]))]
    (pg/paginate db {:from        :client_events
                     :base-where  where
                     :order-by    [:id]
                     :limit       limit
                     :cursor-vals cursor-vals
                     :row->entity row->event})))

;; ============================================================
;; Writes
;; ============================================================

(defn- bad [i msg]
  (throw (ex-info (str "Event " i ": " msg) {:code 400 :index i})))

(defn- optional-string [i field v max-len]
  (cond
    (nil? v) nil
    (not (string? v)) (bad i (str field " must be a string"))
    (> (cp/cp-count v) max-len) (bad i (str field " exceeds " max-len " characters"))
    :else (do (storable/assert-storable! field v) v)))

(defn- check-data!
  "Refuse any `data` key outside `type`'s set, and any value that is not a
  string or a number, or is a string past `max-data-value-length`."
  [i type data]
  (let [allowed (data-keys type)]
    (doseq [[k v] data
            :let [k (if (keyword? k) (subs (str k) 1) (str k))]]
      (when-not (allowed k)
        (bad i (str "data key '" k "' is not recorded for " type ". Keys: "
                    (clojure.string/join ", " (sort allowed)))))
      (when-not (or (string? v) (number? v))
        (bad i (str "data key '" k "' must be a string or a number")))
      (when (and (string? v) (> (cp/cp-count v) max-data-value-length))
        (bad i (str "data key '" k "' exceeds " max-data-value-length " characters"))))))

(defn- event->row
  "Check one event and turn it into a row, or throw a 400 naming its index."
  [i {:keys [type document-id target-id data client-ts]} project-id user-id documents ts]
  (when-not (string? type) (bad i "type is required"))
  (when-not (types type)
    (bad i (str "unknown type '" type "'. Types: " (clojure.string/join ", " (sort types)))))
  (when (and (some? data) (not (map? data)))
    (bad i "data must be an object"))
  (check-data! i type data)
  (let [doc-id (some-> document-id str)
        data-json (when (seq data) (json/write-str data))]
    (when (and doc-id (not (contains? documents doc-id)))
      (bad i (str "document " doc-id " is not in this project")))
    (when data-json (storable/assert-storable! "Event data" data-json))
    {:project_id  project-id
     :document_id doc-id
     :user_id     user-id
     :type        type
     :target_id   (optional-string i "target-id" (some-> target-id str) max-target-id-length)
     :data        data-json
     :client_ts   (optional-string i "client-ts" client-ts max-client-ts-length)
     :ts          ts}))

(defn- project-documents
  "The ids among `doc-ids` that are documents of `project-id`, as strings."
  [db project-id doc-ids]
  (if (empty? doc-ids)
    #{}
    (into #{}
          (map (comp str :id))
          (psc/q db {:select [:id] :from [:documents]
                     :where [:and [:= :project_id project-id] [:in :id (vec doc-ids)]]}))))

(defn record!
  "Store `events` (a sequence of maps with `:type` and optional
  `:document-id`, `:target-id`, `:data` and `:client-ts`) for `project-id`
  as `user-id`, all stamped with one server `ts`. All or nothing: one bad
  event refuses the whole request with a 400 that names it. Returns the
  number stored.

  Checks the switch itself, so no caller can store events for a project
  that has not switched them on: that is a 403."
  [db project-id user-id events]
  (when-not (enabled? db project-id)
    (throw (ex-info "Research telemetry is off for this project" {:code 403})))
  (when-not (sequential? events)
    (throw (ex-info "Expected an array of events" {:code 400})))
  (when (> (count events) max-events-per-request)
    (throw (ex-info (str "At most " max-events-per-request " events per request, got " (count events))
                    {:code 400 :count (count events)})))
  (let [events (vec events)
        _ (doseq [[i e] (map-indexed vector events)]
            (when-not (map? e) (bad i "must be an object")))
        doc-ids (into #{} (keep (comp #(some-> % str) :document-id)) events)
        documents (project-documents db project-id doc-ids)
        ts (psc/now-iso)
        rows (vec (map-indexed #(event->row %1 %2 project-id user-id documents ts) events))]
    (when (seq rows)
      ;; Raw insert, NOT `crud/insert!`: that helper needs an operation and
      ;; writes an audit row, and these are neither. See the ns docstring.
      (psc/execute! db {:insert-into :client_events :values rows}))
    (count rows)))
