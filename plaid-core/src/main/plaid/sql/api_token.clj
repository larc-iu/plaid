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
            [plaid.sql.crud :as crud]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.pagination :as pagination])
  (:refer-clojure :exclude [get list]))

(defn- row->api-token
  "Translate an `api_tokens` row (snake_case column keys) to the namespaced
  shape the rest of the system expects. Returns nil on nil input. NEVER
  carries the signed JWT — it is not stored and is only ever returned once,
  at mint time, by the REST layer."
  [row]
  (when row
    ;; `revoked-at` is the source of truth for revocation; a non-nil value
    ;; means the token is dead. (No separate boolean flag — keeps the JSON
    ;; key set clean and avoids a `?`-suffixed wire key.) The table's
    ;; `last_used_at` column is never written, so it is not offered (H2-11-3).
    {:api-token/id           (:id row)
     :api-token/user-id      (:user_id row)
     :api-token/name         (:name row)
     :api-token/created-at   (:created_at row)
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

(defn- with-last-writes
  "Each of `tokens` with `:api-token/last-write-at`, the time of the newest
  operation carrying its id, or nil for one that never wrote. One grouped
  read over the existing `idx_operations_token`, which visits each token's
  own operations: measured 2026-11-20 on a copy of the scale fixture grown
  to 1M operations, 127 ms for a token holding 400k of them and 15 ms for
  one holding 10k. No index on `operations` is added for it."
  [db tokens]
  (let [ids (keep :api-token/id tokens)
        newest (when (seq ids)
                 (into {} (map (juxt :token_id :ts))
                       (psc/q db {:select [:token_id [[:max :ts] :ts]]
                                  :from [:operations]
                                  :where [:in :token_id (vec ids)]
                                  :group-by [:token_id]})))]
    (mapv #(assoc % :api-token/last-write-at (clojure.core/get newest (:api-token/id %))) tokens)))

(defn list-for-user
  "All tokens owned by `user-id`, oldest-first, in external shape, each with
  when it last wrote (`with-last-writes`). Includes
  revoked tokens (the UI shows them as revoked rather than hiding them).

  Ordered by `(created_at, id)` — `:id` is the unique tiebreaker that makes
  the order a deterministic total order (required for keyset pagination).

  Bare arity `([db user-id])` returns a plain vector. Paginated arity
  `([db user-id opts])` returns the uniform `{:entries :next-cursor}`
  envelope."
  ([db user-id]
   (->> (psc/q db {:select [:*]
                   :from [:api_tokens]
                   :where [:= :user_id user-id]
                   :order-by [:created_at :id]})
        (mapv row->api-token)
        (with-last-writes db)))
  ([db user-id {:keys [limit cursor-vals]}]
   (-> (pagination/paginate db {:from :api_tokens
                                :base-where [:= :user_id user-id]
                                :order-by [:created_at :id]
                                :limit limit
                                :cursor-vals cursor-vals
                                :row->entity row->api-token})
       (update :entries #(with-last-writes db %)))))

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
                     (psc/assert-valid-name! name)
                     ;; A deactivated account's tokens were revoked with it,
                     ;; and reactivation restores none: a token minted now
                     ;; would come alive on reactivation (ACL6-3).
                     (when (some? (:deactivated_at (psc/fetch-by-id tx :users owner-user-id)))
                       (throw (ex-info (str "User " owner-user-id " is deactivated. Reactivate them before "
                                            "minting a token.")
                                       {:code 400 :id owner-user-id})))
                     (let [id (psc/new-uuid)
                           row {:id         id
                                :user_id    owner-user-id
                                :name       name
                                :created_at (psc/now-iso)}]
                       (crud/insert! tx :api_tokens row)
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
                         (crud/update-by-id! tx :api_tokens id {:revoked_at (psc/now-iso)}))
                       id)))
