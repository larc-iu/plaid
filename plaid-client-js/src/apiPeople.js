/**
 * The people bundles: users, their API tokens and private data, invites and
 * the signed-in user's sign-ins, each a factory of the client (client.js
 * installs them).
 */

import { auditMethods, bodyOf } from "./families.js";
import { normalizeUserId } from "./ids.js";
import { iterPages, listAll, listPage } from "./pagination.js";

/** An avatar token is minted again once less than this is left of it. */
const AVATAR_TOKEN_RENEW_MS = 10 * 60 * 1000;
// An avatar token minted this recently is the renewal a caller asking for one
// wanted.
const AVATAR_TOKEN_FRESH_MS = 5 * 1000;

/**
 * @typedef {import("./types.js").TextEditOp} TextEditOp
 * @typedef {import("./types.js").TextGap} TextGap
 * @typedef {import("./types.js").MetadataOp} MetadataOp
 * @typedef {import("./types.js").LayerConstraint} LayerConstraint
 * @typedef {import("./types.js").ConstraintWriteOptions} ConstraintWriteOptions
 * @typedef {import("./types.js").ConstraintViolation} ConstraintViolation
 * @typedef {import("./types.js").Requester} Requester
 * @typedef {import("./types.js").BatchRef} BatchRef
 * @typedef {import("./types.js").ServiceParam} ServiceParam
 * @typedef {import("./types.js").ServiceInfo} ServiceInfo
 * @typedef {import("./types.js").DiscoveredService} DiscoveredService
 * @typedef {import("./types.js").ResponseHelper} ResponseHelper
 * @typedef {import("./types.js").ServiceRegistration} ServiceRegistration
 * @typedef {import("./types.js").ServiceStatusEvent} ServiceStatusEvent
 * @typedef {import("./types.js").OperationGroupsBundle} OperationGroupsBundle
 * @typedef {import("./types.js").PlaidClientOptions} PlaidClientOptions
 * @typedef {import("./types.js").OperationKind} OperationKind
 * @typedef {import("./types.js").KeySeed} KeySeed
 * @typedef {import("./types.js").PlaidBatch} PlaidBatch
 * @typedef {import("./types.js").AuditPageOptions} AuditPageOptions
 * @typedef {import("./types.js").VocabItemRestoreSummary} VocabItemRestoreSummary
 * @typedef {import("./types.js").UserDataEntry} UserDataEntry
 * @typedef {import("./types.js").AdminUserDataEntry} AdminUserDataEntry
 * @typedef {import("./types.js").ActivityTallyRow} ActivityTallyRow
 * @typedef {import("./types.js").ConstraintRepair} ConstraintRepair
 * @typedef {import("./types.js").ValueSetRule} ValueSetRule
 * @typedef {import("./types.js").RefusedValues} RefusedValues
 * @typedef {import("./types.js").CommentableType} CommentableType
 * @typedef {import("./types.js").Comment} Comment
 * @typedef {import("./types.js").Guideline} Guideline
 * @typedef {import("./types.js").ClientEventType} ClientEventType
 * @typedef {import("./types.js").ClientEvent} ClientEvent
 * @typedef {import("./types.js").Invite} Invite
 * @typedef {import("./types.js").ServerLimits} ServerLimits
 * @typedef {import("./types.js").ServerHealth} ServerHealth
 * @typedef {import("./types.js").RateLimitBucket} RateLimitBucket
 * @typedef {import("./types.js").RateLimitSnapshot} RateLimitSnapshot
 * @typedef {import("./types.js").BackupStatus} BackupStatus
 * @typedef {import("./types.js").ServerReport} ServerReport
 * @typedef {import("./types.js").LiveLog} LiveLog
 * @typedef {import("./types.js").SSEConnection} SSEConnection
 * @typedef {import("./types.js").SSEStats} SSEStats
 * @typedef {import("./types.js").AtomicValue} AtomicValue
 * @typedef {import("./types.js").Created} Created
 * @typedef {import("./types.js").Project} Project
 * @typedef {import("./types.js").ProjectTextLayer} ProjectTextLayer
 * @typedef {import("./types.js").ProjectTokenLayer} ProjectTokenLayer
 * @typedef {import("./types.js").ProjectSpanLayer} ProjectSpanLayer
 * @typedef {import("./types.js").ProjectRelationLayer} ProjectRelationLayer
 * @typedef {import("./types.js").ProjectVocab} ProjectVocab
 * @typedef {import("./types.js").PlaidDocument} PlaidDocument
 * @typedef {import("./types.js").DocumentTextLayer} DocumentTextLayer
 * @typedef {import("./types.js").DocumentTokenLayer} DocumentTokenLayer
 * @typedef {import("./types.js").DocumentSpanLayer} DocumentSpanLayer
 * @typedef {import("./types.js").PlaidText} PlaidText
 * @typedef {import("./types.js").TextReshape} TextReshape
 * @typedef {import("./types.js").Token} Token
 * @typedef {import("./types.js").Span} Span
 * @typedef {import("./types.js").Relation} Relation
 * @typedef {import("./types.js").VocabItem} VocabItem
 * @typedef {import("./types.js").VocabLink} VocabLink
 * @typedef {import("./types.js").VocabLayer} VocabLayer
 * @typedef {import("./types.js").TextLayer} TextLayer
 * @typedef {import("./types.js").TokenLayer} TokenLayer
 * @typedef {import("./types.js").SpanLayer} SpanLayer
 * @typedef {import("./types.js").RelationLayer} RelationLayer
 * @typedef {import("./types.js").MetadataRecords} MetadataRecords
 * @typedef {import("./types.js").LayerRecords} LayerRecords
 * @typedef {import("./types.js").User} User
 * @typedef {import("./types.js").ProjectListEntry} ProjectListEntry
 * @typedef {import("./types.js").DocumentListEntry} DocumentListEntry
 * @typedef {import("./types.js").ApiToken} ApiToken
 * @typedef {import("./types.js").AuditUser} AuditUser
 * @typedef {import("./types.js").AuditTarget} AuditTarget
 * @typedef {import("./types.js").AuditOp} AuditOp
 * @typedef {import("./types.js").AuditEntry} AuditEntry
 * @typedef {import("./types.js").LockGrant} LockGrant
 * @typedef {import("./types.js").DocumentRestoreSummary} DocumentRestoreSummary
 * @typedef {import("./types.js").RestoreCounts} RestoreCounts
 * @typedef {import("./types.js").OperationGroup} OperationGroup
 * @typedef {import("./types.js").QueryResult} QueryResult
 */

/**
 * @template [T=any]
 * @typedef {import("./types.js").Page<T>} Page
 */

/** @param {import("./client.js").PlaidClient} client */
export function usersApi(client) {
  return {
    /**
     * Get a user by ID
     * @param {string} id - The resource ID
     * @returns {Promise<User>}
     */
    get: (id) =>
      client._request("GET", `/api/v1/users/${id}`),
    /**
     * Fetch a user's profile picture as raw bytes. Most callers want
     * avatarUrl() instead. This one is for non-browser consumers.
     * @param {string} id - The user ID
     * @returns {Promise<ArrayBuffer>}
     */
    getAvatar: (id) =>
      client._request("GET", `/api/v1/users/${id}/avatar`, {
        binaryResponse: true,
      }),
    /**
     * List (or search) users. Transparently follows pagination cursors and
     * returns the full flat array. Admin-or-maintainer only.
     * @param {object} [opts]
     * @param {string} [opts.q] - Filter to users whose display name contains this text, or whose email starts with it (contains it, when the text holds an at sign), case-insensitive
     * @returns {Promise<User[]>}
     */
    list: ({ q } = {}) =>
      listAll(client, "/api/v1/users", { query: { q } }),
    /**
     * Fetch a single page of users (optionally filtered by `q`).
     * @param {object} [opts]
     * @param {string} [opts.q] - Filter to users whose display name contains this text, or whose email starts with it (contains it, when the text holds an at sign), case-insensitive
     * @param {number} [opts.limit] - Page size (1..1000; server default 100)
     * @param {string} [opts.cursor] - Opaque cursor from a previous page
     * @returns {Promise<Page<User>>}
     */
    listPage: ({ q, limit, cursor } = {}) =>
      listPage(client, "/api/v1/users", {
        limit,
        cursor,
        query: { q },
      }),
    /**
     * Async-iterate users page by page; yields each page's entries array.
     * @param {object} [opts]
     * @param {string} [opts.q] - Filter to users whose display name contains this text, or whose email starts with it (contains it, when the text holds an at sign), case-insensitive
     * @param {number} [opts.pageSize] - Per-request page size
     * @returns {AsyncGenerator<User[]>}
     */
    iterPages: ({ q, pageSize } = {}) =>
      iterPages(client, "/api/v1/users", {
        pageSize,
        query: { q },
      }),
    /**
     * Create a new user. Admin only, and not with a named API token (403):
     * it needs a sign-in token.
     * @param {string} email - The account's email address. It becomes the
     *   user's id and is what they log in with; it can never be changed.
     * @param {string} password - The password
     * @param {boolean} isAdmin - Whether the user is an admin
     * @param {string} [displayName] - How the user is shown in the UI.
     *   Defaults to the local part of the email.
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<Created>}
     */
    create: (email, password, isAdmin, displayName, auditMessage) =>
      client._request("POST", "/api/v1/users", {
        auditMessage,
        body: bodyOf({
          email: normalizeUserId(email),
          password,
          "is-admin": isAdmin,
          // Left out when not given (null too), so core gives the user the
          // local part of the email. Core refuses a null display name.
          "display-name": displayName ?? undefined,
        }),
      }),
    /**
     * Modify a user. Admins may change the display name, password, and admin
     * status of any user. All other users may only modify their own display
     * name or password. A password change cannot be made with a named API
     * token (403): it needs a sign-in token.
     *
     * A user's id is their email address and is fixed for the life of the
     * account — it is what they log in with, so nothing can change it.
     * @param {string} id - The resource ID (the user's email address)
     * @param {string} [password] - New password
     * @param {string} [displayName] - New display name
     * @param {boolean} [isAdmin] - New admin status
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<User>}
     */
    update: (id, password, displayName, isAdmin, auditMessage) =>
      client._request("PATCH", `/api/v1/users/${id}`, {
        auditMessage,
        body: bodyOf({
          password,
          "display-name": displayName,
          "is-admin": isAdmin,
        }),
      }),
    /**
     * Deactivate a user. Users are never hard-deleted: deactivation
     * rejects their logins and tokens, strips their project memberships
     * and vocab maintainerships, and revokes their API tokens. The user
     * stays visible in listings with a deactivated-at timestamp.
     * Reversible via activate(), which restores login only.
     * @param {string} id - The resource ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    delete: (id, auditMessage) =>
      client._request("DELETE", `/api/v1/users/${id}`, { auditMessage }),
    /**
     * Reactivate a deactivated user, restoring their ability to log in.
     * Project memberships, vocab maintainerships, and API tokens removed
     * at deactivation are NOT restored — re-grant them deliberately.
     * @param {string} id - The resource ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<User>}
     */
    activate: (id, auditMessage) =>
      client._request("POST", `/api/v1/users/${id}/activate`, { auditMessage }),
    /**
     * A token that shows any user's profile picture without an
     * Authorization header, for an `<img>`, which cannot send one. Resolves
     * to `{ token, expiresAt }` (`expiresAt` an ISO-8601 instant, a day on by
     * default). The server refuses it on every route but the picture, and
     * it stops working when the user signs out or changes password.
     *
     * One token serves the whole client: it is kept and handed out again
     * until under ten minutes of it remain (half its life, for one minted
     * near the end of a login), calls made while one is being minted share
     * that request, and it is dropped when the client's token changes.
     * avatarUrl() uses it.
     * @param {{renew?: boolean}} [options] - `renew`: mint a new one
     *   whatever is kept, unless one was minted in the last few seconds
     *   (or is being minted), which is shared
     * @returns {Promise<{token: string, expiresAt: string}>}
     */
    avatarToken: ({ renew = false } = {}) => {
      // A batch is a view of its client and shares the client's token.
      const owner = client.client ?? client;
      const cached = owner._avatarToken;
      if (cached && cached.forToken === owner.token) {
        if (cached.pending) return cached.pending;
        const now = owner.serverNow().getTime();
        // A renewal shares one minted a moment ago: every picture on a page
        // fails together when a token dies, and each asks.
        if (renew && now - cached.mintedAt < AVATAR_TOKEN_FRESH_MS) {
          return Promise.resolve(cached.link);
        }
        const expires = Date.parse(cached.link.expiresAt);
        // Renewed ten minutes before it runs out, or at half its life when
        // it was minted for less than twenty: the server caps it at the
        // login's own expiry, and near the end of a login every token it
        // mints runs out at that same moment, so a fixed ten minutes asked
        // for a new one on every call.
        const renewAt = Math.min(AVATAR_TOKEN_RENEW_MS, (expires - cached.mintedAt) / 2);
        if (!renew && expires - now > renewAt) return Promise.resolve(cached.link);
      }
      const entry = {
        forToken: owner.token,
        pending: null,
        link: null,
        mintedAt: owner.serverNow().getTime(),
      };
      entry.pending = owner
        ._request("POST", "/api/v1/avatar-link", { outOfBand: true })
        .then(
          (link) => {
            entry.pending = null;
            entry.link = link;
            return link;
          },
          (e) => {
            if (owner._avatarToken === entry) owner._avatarToken = null;
            throw e;
          },
        );
      owner._avatarToken = entry;
      return entry.pending;
    },
    /**
     * Build a URL for a user's profile picture, for an `<img>` src. The
     * URL carries the client's avatar token (see avatarToken()), never the
     * login token.
     *
     * Pass the user record's `avatarHash` as the second argument whenever you
     * have it: the URL then addresses that exact picture, so the browser can
     * cache it indefinitely and still pick up a replacement the moment the
     * user changes it. Resolves to null when `avatarHash` is null (the user
     * has no picture), so callers can fall back to initials without a
     * wasted request.
     * @param {string} id - The user ID
     * @param {string|null} [avatarHash] - The user record's `avatarHash`
     * @param {{renew?: boolean}} [options] - `renew`: mint a new avatar
     *   token first, for a picture its URL failed to load (the token
     *   stops working when the login it was minted under ends)
     * @returns {Promise<string|null>}
     */
    avatarUrl: async (id, avatarHash, { renew = false } = {}) => {
      if (avatarHash === null) return null;
      // Through `self`, as in server.limits.
      const self = client;
      const { token } = await self.users.avatarToken({ renew });
      const params = new URLSearchParams({ "avatar-token": token });
      if (avatarHash) params.set("v", avatarHash);
      return `${client.baseUrl}/api/v1/users/${id}/avatar?${params}`;
    },
    /**
     * Upload a profile picture. Your own, or anyone's if you are an admin.
     * The server center-crops to a square, scales to the configured edge
     * length, and re-encodes, so no client-side resizing is needed. Accepts
     * PNG, JPEG, WebP, and GIF. Resolves to the updated user record.
     * @param {string} id - The user ID
     * @param {File} file - The image to upload
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<User>}
     */
    setAvatar: (id, file, auditMessage) => {
      const fd = new FormData();
      fd.append("file", file);
      return client._request("PUT", `/api/v1/users/${id}/avatar`, {
        auditMessage,
        body: fd,
        formData: true,
        noBatch: true,
      });
    },
    /**
     * Remove a profile picture. Your own, or anyone's if you are an admin.
     * @param {string} id - The user ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    // No flag: the upload beside this one is multipart and cannot be
    // batched, but a DELETE carries no blob, so the batch transport takes
    // it. It is an ordinary audited write and queues like any other.
    deleteAvatar: (id, auditMessage) =>
      client._request("DELETE", `/api/v1/users/${id}/avatar`, {
        auditMessage,
      }),
    ...auditMethods(client, "users"),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function apiTokensApi(client) {
  return {
    /**
     * List a user's named API tokens. Never includes the signed token
     * string itself — that is only returned once, by create().
     * Transparently follows pagination cursors and returns the full flat array.
     * @param {string} userId - The user ID who owns the tokens
     * @returns {Promise<ApiToken[]>}
     */
    list: (userId) => listAll(client, `/api/v1/users/${userId}/tokens`),
    /**
     * Fetch a single page of a user's named API tokens.
     * @param {string} userId - The user ID who owns the tokens
     * @param {object} [opts]
     * @param {number} [opts.limit] - Page size (1..1000; server default 100)
     * @param {string} [opts.cursor] - Opaque cursor from a previous page
     * @returns {Promise<Page<ApiToken>>}
     */
    listPage: (userId, { limit, cursor } = {}) =>
      listPage(client, `/api/v1/users/${userId}/tokens`, { limit, cursor }),
    /**
     * Async-iterate a user's named API tokens page by page; yields each
     * page's entries array.
     * @param {string} userId - The user ID who owns the tokens
     * @param {object} [opts]
     * @param {number} [opts.pageSize] - Per-request page size
     * @returns {AsyncGenerator<ApiToken[]>}
     */
    iterPages: (userId, { pageSize } = {}) =>
      iterPages(client, `/api/v1/users/${userId}/tokens`, { pageSize }),
    /**
     * Mint a named API token for a user. The returned `token` is the signed
     * credential and is shown ONLY here — store it immediately. API tokens
     * do not expire and survive password changes / logout; revoke to kill.
     * A client signed in with a named API token cannot do this (403): it
     * needs a sign-in token.
     * @param {string} userId - The user ID who will own the token
     * @param {string} name - A human label, e.g. "Stanza parser"
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<{id: string, name: string, token: string}>}
     */
    create: (userId, name, auditMessage) =>
      client._request("POST", `/api/v1/users/${userId}/tokens`, {
        auditMessage,
        body: bodyOf({ name }),
        // The answer is the secret, which the server never keeps, so it
        // takes no Idempotency-Key and a batch cannot carry it.
        noBatch: true,
      }),
    /**
     * Revoke a named API token (soft-revoke; idempotent).
     * A client signed in with a named API token cannot do this (403): it
     * needs a sign-in token.
     * @param {string} userId - The user ID who owns the token
     * @param {string} tokenId - The token ID to revoke
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    revoke: (userId, tokenId, auditMessage) =>
      client._request("DELETE", `/api/v1/users/${userId}/tokens/${tokenId}`, {
        auditMessage,
      }),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function invitesApi(client) {
  return {
    /**
     * List invites you minted, oldest first. With `projectId`, lists that
     * project's invites instead (including co-maintainers'), which requires
     * maintainer or admin on it. Never includes invite codes — the code is
     * returned once, by create(), and is not recoverable afterward.
     * Transparently follows pagination cursors and returns the full flat array.
     * @param {object} [opts]
     * @param {string} [opts.projectId] - List this project's invites instead of your own
     * @param {boolean} [opts.all] - List every invite on the server (admin only)
     * @returns {Promise<Invite[]>}
     */
    list: ({ projectId, all } = {}) =>
      listAll(client, "/api/v1/invites", {
        query: { "project-id": projectId, all },
      }),
    /**
     * Fetch a single page of invites.
     * @param {object} [opts]
     * @param {string} [opts.projectId] - List this project's invites instead of your own
     * @param {boolean} [opts.all] - List every invite on the server (admin only)
     * @param {number} [opts.limit] - Page size (1..1000; server default 100)
     * @param {string} [opts.cursor] - Opaque cursor from a previous page
     * @returns {Promise<Page<Invite>>}
     */
    listPage: ({ projectId, all, limit, cursor } = {}) =>
      listPage(client, "/api/v1/invites", {
        limit,
        cursor,
        query: { "project-id": projectId, all },
      }),
    /**
     * Async-iterate invites page by page; yields each page's entries array.
     * @param {object} [opts]
     * @param {string} [opts.projectId] - List this project's invites instead of your own
     * @param {boolean} [opts.all] - List every invite on the server (admin only)
     * @param {number} [opts.pageSize] - Per-request page size
     * @returns {AsyncGenerator<Invite[]>}
     */
    iterPages: ({ projectId, all, pageSize } = {}) =>
      iterPages(client, "/api/v1/invites", {
        pageSize,
        query: { "project-id": projectId, all },
      }),
    /**
     * Mint an invite. The returned `code` is shown ONLY here — it is never
     * stored and cannot be recovered, so build and hand off the link now.
     * Use PlaidClient.inviteUrl() to turn it into one.
     *
     * Admins may mint anything. A project maintainer may mint role grants on
     * projects they maintain, and nothing else: no admin grant, no grantless
     * invite, no password resets — so for a non-admin, projectId/projectRole
     * are required in practice (403 without them).
     *
     * Needs a signed-in session: a client signed in with a named API token
     * cannot mint any invite (403).
     *
     * EVERY option is optional; `create()` with no arguments mints a
     * single-use signup link granting nothing but an account. Two pairing
     * rules the server enforces with a 400: projectId and projectRole must be
     * given TOGETHER, and targetUserId may not be combined with projectId,
     * grantAdmin, or a maxUses above 1.
     * @param {object} [opts]
     * @param {string} [opts.projectId] - Project the redeemer joins (requires projectRole)
     * @param {string} [opts.projectRole] - "reader" | "writer" | "maintainer" (requires projectId)
     * @param {boolean} [opts.grantAdmin] - Make the new account a global admin (admin only)
     * @param {string} [opts.targetUserId] - Password reset for that user instead of a signup; admin only, single-use, grants nothing
     * @param {number} [opts.maxUses] - How many accounts this link may create (default 1)
     * @param {number} [opts.ttlDays] - Days until it expires (default 14, max 365)
     * @param {string} [opts.note] - Human label shown in your invite list
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<Invite & {code: string}>}
     */
    create: (
      {
        projectId,
        projectRole,
        grantAdmin,
        targetUserId,
        maxUses,
        ttlDays,
        note,
      } = {},
      auditMessage,
    ) =>
      client._request("POST", "/api/v1/invites", {
        auditMessage,
        // The answer is the code, which the server never keeps, so it
        // takes no Idempotency-Key and a batch cannot carry it.
        noBatch: true,
        body: bodyOf({
          "project-id": projectId,
          "project-role": projectRole,
          "grant-admin": grantAdmin,
          "target-user-id": targetUserId,
          "max-uses": maxUses,
          "ttl-days": ttlDays,
          note,
        }),
      }),
    /**
     * Revoke an invite, killing the link immediately. Idempotent. Allowed for
     * the creator, an admin, or a maintainer of the invite's project.
     * @param {string} id - The invite ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    revoke: (id, auditMessage) =>
      client._request("DELETE", `/api/v1/invites/${id}`, { auditMessage }),
  };
}

// The signed-in user's sign-ins. Signing in is `PlaidClient.login`, which
// makes the client.
/** @param {import("./client.js").PlaidClient} client */
export function authApi(client) {
  return {
    /**
     * End every sign-in of this user on every device: each browser tab,
     * script and service holding one of the user's sign-in tokens is
     * refused from now on, this client included. Named API tokens are not
     * affected (revoke one with `apiTokens.revoke`). To sign out of one tab
     * only, discard its token instead. A signal rather than project data:
     * made on a batch it still goes out at once, and it never joins an
     * operation.
     * @returns {Promise<void>}
     */
    logoutEverywhere: async () => {
      await client._request("POST", "/api/v1/logout", { outOfBand: true });
    },
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function userDataApi(client) {
  return {
    /**
     * Read one private data entry ({key, updatedAt, version, value}); 404 if absent.
     * @param {string} userId
     * @param {string} key
     * @returns {Promise<UserDataEntry & {value: any}>}
     */
    get: (userId, key) =>
      client._request(
        "GET",
        `/api/v1/users/${userId}/data/${encodeURIComponent(key)}`,
      ),
    /**
     * List a user's private data entries ({key, updatedAt}, plus value when
     * includeValues), ordered by key. Owner or admin only. Transparently
     * follows pagination cursors and returns the full flat array.
     *
     * Narrow with `prefix` (the literal head of a key) and/or `pattern`, a
     * GLOB over the whole key (`*` any run, `?` one character) — the way to
     * ask for a key convention identified by a segment in the middle, e.g.
     * `igt:assistant:*:meta:*` for every conversation's sidebar entry across
     * every project without dragging down the transcripts beside them.
     *
     * `pageSize` is exposed here, and defaults lower than elsewhere, because
     * one value runs to megabytes (`userDataValueBytes` in
     * `server.limits()`): a page of them with `includeValues` is the
     * largest response this API can be asked for. Raise it when the listing
     * is keys, or the values are known to be small.
     * @param {string} userId
     * @param {object} [opts]
     * @param {string} [opts.prefix] - Only keys starting with this prefix
     * @param {string} [opts.pattern] - Only keys matching this GLOB
     * @param {boolean} [opts.includeValues] - Also return each entry's value
     * @param {number} [opts.pageSize=100] - Entries per request (1..1000)
     * @returns {Promise<UserDataEntry[]>}
     */
    list: (userId, { prefix, pattern, includeValues, pageSize = 100 } = {}) =>
      listAll(client, `/api/v1/users/${userId}/data`, {
        pageSize,
        query: { prefix, pattern, "include-values": includeValues },
      }),
    /**
     * One page of a user's private data entries, ordered by key.
     * @param {string} userId
     * @param {object} [opts]
     * @param {string} [opts.prefix] - Only keys starting with this prefix
     * @param {string} [opts.pattern] - Only keys matching this GLOB
     * @param {boolean} [opts.includeValues] - Also return each entry's value
     * @param {number} [opts.limit] - Page size (1..1000; server default 100)
     * @param {string} [opts.cursor] - Opaque cursor from a previous page
     * @returns {Promise<Page<UserDataEntry>>}
     */
    listPage: (
      userId,
      { prefix, pattern, includeValues, limit, cursor } = {},
    ) =>
      listPage(client, `/api/v1/users/${userId}/data`, {
        limit,
        cursor,
        query: { prefix, pattern, "include-values": includeValues },
      }),
    /**
     * Async generator over a user's private data entries, one page at a time.
     * @param {string} userId
     * @param {object} [opts]
     * @param {string} [opts.prefix] - Only keys starting with this prefix
     * @param {string} [opts.pattern] - Only keys matching this GLOB
     * @param {boolean} [opts.includeValues] - Also return each entry's value
     * @param {number} [opts.pageSize=100] - Entries per request (1..1000)
     * @returns {AsyncGenerator<UserDataEntry[]>}
     */
    iterPages: (
      userId,
      { prefix, pattern, includeValues, pageSize = 100 } = {},
    ) =>
      iterPages(client, `/api/v1/users/${userId}/data`, {
        pageSize,
        query: { prefix, pattern, "include-values": includeValues },
      }),
    /**
     * Delete one private data entry; 404 if absent.
     * @param {string} userId
     * @param {string} key
     * @returns {Promise<void>}
     */
    delete: (userId, key) =>
      client._request(
        "DELETE",
        `/api/v1/users/${userId}/data/${encodeURIComponent(key)}`,
        {
          noBatch: true,
        },
      ),
    /**
     * Create or replace one private data entry. `value` is any JSON, up to
     * the server's `userDataValueBytes` (`server.limits()`, 5 MB by
     * default), and is refused with 413 over it, after which
     * `server.limits()` answers the figure the server has now. Not audited,
     * not batchable.
     *
     * The server stores it verbatim, but this client recases object keys on
     * the way out and back like any other body (`myKey` <-> `my-key`), so a
     * value whose keys are camelCase round-trips unchanged while one keyed
     * by arbitrary strings does not. Put such a map under a `metadata` key,
     * which both clients pass through untouched.
     *
     * Every write raises the entry's `version` by one, and reads answer it.
     * With `version`, the write lands only when the entry is still at that
     * version (0: only when there is no entry), and is otherwise refused with
     * 409, `error: "version-mismatch"`, and the stored `version` and
     * `updatedAt` on the error's `responseData`: read it again and make the
     * change on what is there.
     * @param {string} userId
     * @param {string} key
     * @param {*} value
     * @param {object} [opts]
     * @param {number} [opts.version] - The version this write was made from
     * @returns {Promise<{key: string, updatedAt: string, version: number}>}
     */
    put: async (userId, key, value, { version } = {}) => {
      try {
        return await client._request(
          "PUT",
          `/api/v1/users/${userId}/data/${encodeURIComponent(key)}`,
          {
            body: value,
            noBatch: true,
            queryParams: { version },
          },
        );
      } catch (err) {
        if (err?.status === 413) {
          // The cap may have changed since it was read: the caller deciding
          // what to do next reads the server's figure now.
          await client.server.refresh().catch(() => {});
        }
        throw err;
      }
    },
  };
}
