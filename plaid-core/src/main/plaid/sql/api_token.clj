(ns plaid.sql.api-token
  "Named per-user API tokens. Each row is a distinct, revocable credential
  affiliated with a user. The credential itself is a signed JWT carrying a
  `:token/id` claim equal to `api_tokens.id` (minted in
  `plaid.rest-api.v1.auth/issue-api-token!`); this table holds only the
  server-side reference used for revocation + audit attribution. The signed
  JWT is NEVER stored.

  Revocation is SOFT: set `revoked_at` rather than deleting the row, so
  `operations.token_id` (which FKs here) can always resolve the named
  credential that performed a historical action. See the migration
  `20260601120000-api-tokens` for the rationale.

  Mirrors the read/write shape of `plaid.sql.user`: `db` is a DataSource
  (reads) or an in-tx Connection (writes via `submit-operation!`)."
  (:require [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]])
  (:refer-clojure :exclude [get list]))

(def attr-keys
  [:api-token/id
   :api-token/user-id
   :api-token/name
   :api-token/created-at
   :api-token/last-used-at
   :api-token/revoked-at])

(defn- row->api-token
  "Translate an `api_tokens` row (snake_case column keys) to the namespaced
  shape the rest of the system expects. Returns nil on nil input. NEVER
  carries the signed JWT — it is not stored and is only ever returned once,
  at mint time, by the REST layer."
  [row]
  (when row
    ;; `revoked-at` is the source of truth for revocation; a non-nil value
    ;; means the token is dead. (No separate boolean flag — keeps the JSON
    ;; key set clean and avoids a `?`-suffixed wire key.)
    {:api-token/id           (:id row)
     :api-token/user-id      (:user_id row)
     :api-token/name         (:name row)
     :api-token/created-at   (:created_at row)
     :api-token/last-used-at (:last_used_at row)
     :api-token/revoked-at   (:revoked_at row)}))

;; reads ---------------------------------------------------------------------------

(defn get-internal
  "Get a token row by ID (full row). Returns nil if absent."
  [db id]
  (psc/fetch-by-id db :api_tokens id))

(defn get
  "Get a token by ID in the external (namespaced) shape, or nil."
  [db id]
  (row->api-token (get-internal db id)))

(defn list-for-user
  "All tokens owned by `user-id`, oldest-first, in external shape. Includes
  revoked tokens (the UI shows them as revoked rather than hiding them)."
  [db user-id]
  (->> (psc/q db {:select [:*]
                  :from [:api_tokens]
                  :where [:= :user_id user-id]
                  :order-by [:created_at]})
       (mapv row->api-token)))

(defn active?
  "True iff a token with `id` exists AND has not been revoked. This is the
  authority `wrap-read-jwt` consults to decide whether an API-token JWT is
  still good (API tokens deliberately don't ride the `password_changes`
  invalidation that session tokens do)."
  [db id]
  (let [row (get-internal db id)]
    (boolean (and row (nil? (:revoked_at row))))))

;; writes --------------------------------------------------------------------------

(defn create!
  "Mint a new token row for `owner-user-id` labelled `name`. The op is
  attributed to `acting-user-id` (who may be the owner or an admin acting on
  their behalf). Returns {:success true :extra <token-id>} so the caller can
  sign a JWT carrying that id; on failure {:success false :code :error}.

  Validation (non-blank, length) runs INSIDE the op body so it projects to a
  structured 400 rather than a raw 500."
  [db owner-user-id name acting-user-id]
  (submit-operation! [tx db {:type :api-token/create
                             :project nil
                             :document nil
                             :description (str "Create API token \"" name "\" for user " owner-user-id)
                             :user acting-user-id}]
                     (psc/valid-name? name)
                     (let [id (psc/new-uuid)
                           row {:id         id
                                :user_id    owner-user-id
                                :name       name
                                :created_at (psc/now-iso)}]
                       (psc/insert! tx :api_tokens row)
                       id)))

(defn revoke!
  "Soft-revoke the token `id` (set `revoked_at`). The op is attributed to
  `acting-user-id`. 404s if the token doesn't exist; re-revoking an already
  revoked token is an idempotent no-op (keeps the original timestamp).
  Returns {:success true :extra <token-id>} / {:success false ...}."
  [db id acting-user-id]
  (submit-operation! [tx db {:type :api-token/revoke
                             :project nil
                             :document nil
                             :description (str "Revoke API token " id)
                             :user acting-user-id}]
                     (let [existing (get-internal tx id)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "API token" id) {:code 404 :id id})))
                       (when (nil? (:revoked_at existing))
                         (psc/update-by-id! tx :api_tokens id {:revoked_at (psc/now-iso)}))
                       id)))

(defn touch-last-used!
  "Best-effort, UNAUDITED update of `last_used_at`. Deliberately NOT routed
  through `submit-operation!` — it fires on every authenticated API-token
  request, so an audit row per request would swamp the log. Currently
  unused (deferred); kept here so the read path has an obvious home if/when
  last-used tracking is wired in."
  [db id]
  (psc/execute! db {:update :api_tokens
                    :set {:last_used_at (psc/now-iso)}
                    :where [:= :id id]}))
