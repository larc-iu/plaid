/**
 * The method families the API bundles are built from (a bundle takes
 * `...metadataMethods(client, "spans")` and the like) and the small wire
 * helpers they share: a body without its undefined keys, a list filter as a
 * comma-separated value, and an audit read's query.
 */

import { constraintsBody } from "./constraints.js";
import { listAll, listPage } from "./pagination.js";

/** @typedef {import("./client.js").PlaidClient} PlaidClient */
/**
 * @typedef {import("./types.js").MetadataOp} MetadataOp
 * @typedef {import("./types.js").LayerConstraint} LayerConstraint
 * @typedef {import("./types.js").ConstraintViolation} ConstraintViolation
 * @typedef {import("./types.js").OperationKind} OperationKind
 * @typedef {import("./types.js").ConstraintRepair} ConstraintRepair
 * @typedef {import("./types.js").ValueSetRule} ValueSetRule
 * @typedef {import("./types.js").RefusedValues} RefusedValues
 * @typedef {import("./types.js").MetadataRecords} MetadataRecords
 * @typedef {import("./types.js").LayerRecords} LayerRecords
 * @typedef {import("./types.js").AuditEntry} AuditEntry
 */

/**
 * @template [T=any]
 * @typedef {import("./types.js").Page<T>} Page
 */

// A list filter in the wire's comma-separated form (`layers`, `op-types`,
// `kinds`). Accepts an array or a ready-made string, and anything empty
// becomes undefined so the key is not sent at all.
export function csvParam(values) {
  if (values === undefined || values === null) return undefined;
  const joined = Array.isArray(values) ? values.join(",") : String(values);
  return joined.length > 0 ? joined : undefined;
}

// Helper: build body object, filtering out undefined values
export function bodyOf(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * The request options of a config write. With `options.expected` present
 * (even as undefined, which means the key was absent) the write is a
 * compare-and-set: `?if-unchanged=true` and the body `{expected, value}`,
 * which the server refuses with a 409 when the stored value is no longer
 * `expected`. Without it the body is the value itself. Config is opaque, so
 * neither body is re-cased.
 */
export function configRequest(auditMessage, value, options, isDelete = false) {
  // The answer is a 204 with no body, so there is nothing to keep un-recased.
  if (!options || !Object.hasOwn(options, "expected")) {
    return isDelete ? { auditMessage } : { auditMessage, rawBody: value };
  }
  const expected = options.expected === undefined ? null : options.expected;
  return {
    auditMessage,
    queryParams: { "if-unchanged": true },
    rawBody: isDelete ? { expected } : { expected, value },
  };
}

/**
 * The query of an audit read: the window, the op-type and kind filters, the
 * one vocabulary entry, and for one page its order, ops limit and entry id. A
 * key left undefined is not sent.
 * @private
 */
export function auditQuery({ startTime, endTime, opTypes, itemId, kinds, order, opsLimit, entryId }) {
  return {
    "start-time": startTime,
    "end-time": endTime,
    "op-types": csvParam(opTypes),
    "item-id": itemId,
    kinds: csvParam(kinds),
    order,
    "ops-limit": opsLimit,
    "entry-id": entryId,
  };
}

/**
 * The audit readers of a document, a project or a user, on
 * `/api/v1/<kind>/<id>/audit`. A vocabulary's take an entry id as well and are
 * its own, and the instance-wide log is `audit.list`.
 * @param {PlaidClient} client
 * @param {"documents"|"projects"|"users"} kind
 */
export function auditMethods(client, kind) {
  const path = (id) => `/api/v1/${kind}/${id}/audit`;
  return {
    /**
     * Get the audit log of a document or a project, or of a user's actions.
     * Transparently follows pagination cursors and returns the full flat
     * array. Each entry, and each of its `ops`, says what kind of credential
     * made it as `credential`: `login`, `named-token` or `delegated` (absent
     * on older operations, `service` on some from 2026-10-06 to 2026-10-08),
     * beside `apiToken` (the named token's id and name) when there was one.
     * @param {string} id - The document, project or user ID
     * @param {string} [startTime] - Start of time range
     * @param {string} [endTime] - End of time range
     * @param {string[]|string} [opTypes] - Only return operations of these
     *   types, spelled as in an entry's `op/type` (e.g.
     *   `['span-layer/create', 'span-layer/delete']`). An entry appears when
     *   one of its operations matches, carrying only the ones that did.
     * @param {string[]|string} [kinds] - Only the entries of operations of
     *   these kinds (e.g. `['review', 'guess-adoption']`), each whole
     * @returns {Promise<AuditEntry[]>}
     */
    audit: (id, startTime, endTime, opTypes, kinds) =>
      listAll(client, path(id), { query: auditQuery({ startTime, endTime, opTypes, kinds }) }),
    /**
     * One page of the same log, newest-first with `order: "desc"`. Use this
     * rather than audit() wherever the caller wants the recent end of a log
     * that may be long: audit() walks every page before it resolves.
     * @param {string} id - The document, project or user ID
     * @param {object} [opts]
     * @param {string} [opts.startTime] - Only entries at or after this instant
     * @param {string} [opts.endTime] - Only entries at or before this instant
     * @param {string[]|string} [opts.opTypes] - Only these op types
     * @param {OperationKind[]|string} [opts.kinds] - Only the entries of operations of these kinds, each whole
     * @param {"asc"|"desc"} [opts.order] - "desc" pages newest-first
     * @param {number} [opts.limit] - Page size (1..1000; server default 100)
     * @param {string} [opts.cursor] - Opaque cursor from a previous page
     * @param {number} [opts.opsLimit] - Keep only each entry's oldest N
     *   operations in `ops` (1..1000). `opCount` on every entry says how
     *   many it has
     * @param {string} [opts.entryId] - Read only this entry, not a page
     * @returns {Promise<Page<AuditEntry>>}
     */
    auditPage: (
      id,
      { startTime, endTime, opTypes, kinds, order, limit, cursor, opsLimit, entryId } = {},
    ) =>
      listPage(client, path(id), {
        limit,
        cursor,
        query: auditQuery({ startTime, endTime, opTypes, kinds, order, opsLimit, entryId }),
      }),
  };
}

/**
 * The three metadata methods of a bundle whose entities carry metadata, on
 * `/api/v1/<kind>/<id>/metadata`. Metadata is opaque, so no body is re-cased.
 * Each answers the entity as its GET does.
 * @template {keyof MetadataRecords} K
 * @param {PlaidClient} client
 * @param {K} kind
 */
export function metadataMethods(client, kind) {
  const path = (id) => `/api/v1/${kind}/${id}/metadata`;
  return {
    /**
     * Replace all metadata of an entity. Keys left out of the new map are removed.
     * @param {string} id - The entity's ID
     * @param {object} body - The new metadata map
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<MetadataRecords[K]>}
     */
    setMetadata: (id, body, auditMessage) =>
      client._request("PUT", path(id), { auditMessage, rawBody: body }),
    /**
     * Remove all metadata from an entity.
     * @param {string} id - The entity's ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<MetadataRecords[K]>}
     */
    deleteMetadata: (id, auditMessage) => client._request("DELETE", path(id), { auditMessage }),
    /**
     * Edit an entity's metadata with a list of ops applied in order, in one operation. `{op: 'set', path, value}` writes value at path, creating missing objects along it; `{op: 'delete', path}` removes the key at path (a no-op when absent). A path is a non-empty array of keys, the first a top-level key. A path through a non-object is refused (400). See metadataOps and applyMetadataOps.
     * @param {string} id - The entity's ID
     * @param {MetadataOp[]} body - The metadata ops
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<MetadataRecords[K]>}
     */
    patchMetadata: (id, body, auditMessage) =>
      client._request("PATCH", path(id), { auditMessage, rawBody: body }),
  };
}

/**
 * The two config methods of a bundle whose records carry editor config, on
 * `/api/v1/<kind>/<id>/config/<namespace>/<key>`.
 * @param {PlaidClient} client
 * @param {string} kind
 */
export function configMethods(client, kind) {
  const path = (id, namespace, configKey) => `/api/v1/${kind}/${id}/config/${namespace}/${configKey}`;
  return {
    /**
     * Set a configuration value in an editor namespace.
     * @param {string} id - The record's ID
     * @param {string} namespace - The config namespace
     * @param {string} configKey - The config key
     * @param {any} configValue - Configuration value to set
     * @param {string} [auditMessage] - Audit message for this write
     * @param {{expected?: any}} [options] - `expected`: the value read for this key (null or undefined when it
     *   was absent). The write is then refused with a 409 when the stored value differs. A value the key
     *   already holds is not written and leaves no audit row, so the value read, expecting it, states in a
     *   batch that the key is unchanged.
     * @returns {Promise<void>}
     */
    setConfig: (id, namespace, configKey, configValue, auditMessage, options) =>
      client._request(
        "PUT",
        path(id, namespace, configKey),
        configRequest(auditMessage, configValue, options),
      ),
    /**
     * Remove a configuration value.
     * @param {string} id - The record's ID
     * @param {string} namespace - The config namespace
     * @param {string} configKey - The config key
     * @param {string} [auditMessage] - Audit message for this write
     * @param {{expected?: any}} [options] - `expected`, as on setConfig. A key that is absent is not
     *   written, so expecting null states in a batch that it is still absent.
     * @returns {Promise<void>}
     */
    deleteConfig: (id, namespace, configKey, auditMessage, options) =>
      client._request(
        "DELETE",
        path(id, namespace, configKey),
        configRequest(auditMessage, undefined, options, true),
      ),
  };
}

/**
 * The get, delete, update and shift methods of the four layer bundles, on
 * `/api/v1/<kind>/<layerId>`.
 * @template {keyof LayerRecords} K
 * @param {PlaidClient} client
 * @param {K} kind
 */
export function layerMethods(client, kind) {
  const path = (layerId) => `/api/v1/${kind}/${layerId}`;
  return {
    /**
     * Get a layer by ID.
     * @param {string} layerId - The layer ID
     * @returns {Promise<LayerRecords[K]>}
     */
    get: (layerId) => client._request("GET", path(layerId)),
    /**
     * Delete a layer.
     * @param {string} layerId - The layer ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    delete: (layerId, auditMessage) => client._request("DELETE", path(layerId), { auditMessage }),
    /**
     * Rename a layer.
     * @param {string} layerId - The layer ID
     * @param {string} name - The new name
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<LayerRecords[K]>}
     */
    update: (layerId, name, auditMessage) =>
      client._request("PATCH", path(layerId), { auditMessage, body: bodyOf({ name }) }),
    /**
     * Move a layer one place in its display order.
     * @param {string} layerId - The layer ID
     * @param {string} direction - The direction ("up" or "down")
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    shift: (layerId, direction, auditMessage) =>
      client._request("POST", `${path(layerId)}/shift`, {
        auditMessage,
        body: bodyOf({ direction }),
      }),
  };
}

/**
 * The four layer-constraint methods of a layer bundle, on `/api/v1/<kind>`.
 * See constraints.js and the core manual, "Layer constraints".
 * @param {PlaidClient} client
 * @param {string} kind
 */
export function constraintMethods(client, kind) {
  const base = (layerId) => `/api/v1/${kind}/${layerId}/constraints`;
  return {
    /**
     * Declare an app namespace's constraints on this layer, replacing that
     * namespace's list. Refused with 422 and the violations when the layer's
     * stored data breaks them (see violationsOf).
     * @param {string} layerId - The layer ID
     * @param {string} namespace - The declaring app's namespace, e.g. "igt"
     * @param {LayerConstraint[]} constraints - e.g. [{type: "single-span"}, {type: "value-set", values: ["N"]}]
     * @param {string} [auditMessage] - Audit message for this write
     * @param {{expected?: Array<object>|null}} [options] - `expected`: the list read for this
     *   namespace (null when it was absent). The write is then refused with a 409 when the stored
     *   list differs.
     * @returns {Promise<{constraints: Record<string, LayerConstraint[]>}>} the layer's whole constraint map
     */
    setConstraints: (layerId, namespace, constraints, auditMessage, options) =>
      client._request("PUT", `${base(layerId)}/${namespace}`, {
        auditMessage,
        body: constraintsBody(constraints, options),
      }),
    /**
     * Remove an app namespace's constraints from this layer.
     * @param {string} layerId - The layer ID
     * @param {string} namespace - The declaring app's namespace
     * @param {string} [auditMessage] - Audit message for this write
     * @param {{expected?: Array<object>|null}} [options] - `expected`, as on setConstraints.
     * @returns {Promise<void>}
     */
    deleteConstraints: (layerId, namespace, auditMessage, options) => {
      const body = constraintsBody(undefined, options);
      return client._request("DELETE", `${base(layerId)}/${namespace}`, {
        auditMessage,
        ...(Object.keys(body).length ? { body } : {}),
      });
    },
    /**
     * The violations the given constraints would meet in this layer's stored
     * data. Writes nothing.
     * @param {string} layerId - The layer ID
     * @param {LayerConstraint[]} constraints - The list to check
     * @param {{limit?: number}} [options] - `limit`: how many violations to list (default 100)
     * @returns {Promise<{violations: ConstraintViolation[], violationCount: number}>}
     */
    // outOfBand: a read that travels as a POST (see the note at the top of
    // http.js), so it goes over the wire from a batch, takes no key and never
    // joins an open operation.
    checkConstraints: (layerId, constraints, options) =>
      client._request("POST", `${base(layerId)}/check`, {
        outOfBand: true,
        body: {
          constraints,
          ...(options?.limit != null ? { limit: options.limit } : {}),
        },
      }),
    /**
     * Apply the remedies of the given constraints' remediable types
     * (coextensive, single-span, single-link, same-ancestor) to every
     * violation in this layer's stored data, one operation per document.
     * With `document`, only that document is repaired, and a writer may
     * ask. A document another user holds the lock on is left as it is and
     * listed under `locked`.
     * @param {string} layerId - The layer ID
     * @param {LayerConstraint[]} constraints - The list to repair for
     * @param {string} [auditMessage] - Audit message for this write
     * @param {{document?: string}} [options]
     * @returns {Promise<{repaired: ConstraintRepair[], locked: Array<{document: string, lockedBy: string}>, violations: ConstraintViolation[], violationCount: number}>}
     */
    repairConstraints: (layerId, constraints, auditMessage, options) =>
      client._request("POST", `${base(layerId)}/repair`, {
        auditMessage,
        body: options?.document ? { constraints, document: options.document } : { constraints },
      }),
  };
}

/**
 * The value-set read of a span or relation layer bundle, on
 * `/api/v1/<kind>/<layerId>/constraints/refused-values`.
 * @param {PlaidClient} client
 * @param {string} kind
 */
export function valueSetMethods(client, kind) {
  return {
    /**
     * The stored values of this layer that a value-set rule would refuse,
     * before it is declared: exactly what a declaration of it would meet,
     * with the rule's exemptions (an unconfirmed machine value, a value an
     * import, a document copy or a restore set). Writes nothing, and a
     * reader may ask.
     * @param {string} layerId - The layer ID
     * @param {ValueSetRule} rule - The list as a value-set declaration takes it
     * @param {{limit?: number}} [options] - `limit`: how many values to list, the most frequent first
     *   (default 20, at most 100)
     * @returns {Promise<RefusedValues>}
     */
    // outOfBand, as checkConstraints.
    refusedValues: (layerId, rule, options) =>
      client._request("POST", `/api/v1/${kind}/${layerId}/constraints/refused-values`, {
        outOfBand: true,
        body: bodyOf({
          values: rule?.values,
          delimiters: rule?.delimiters,
          parts: rule?.parts,
          limit: options?.limit,
        }),
      }),
  };
}
