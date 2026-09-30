/**
 * Layer constraints: rules an app declares on the token, span and relation
 * layers it owns, which the server enforces inside every write. A write that
 * breaks one on a row it writes is refused with 422 and the violations. See
 * the core manual, "Layer constraints".
 */

import { transformResponse } from "./transforms.js";

/** The constraint types, by the layer kind that may carry them. */
export const CONSTRAINT_TYPES = Object.freeze([
  "max-in-degree",
  "acyclic",
  "same-ancestor",
  "single-span",
  "value-set",
  "coextensive",
  "single-link",
]);

/**
 * The violations of a write refused by a layer constraint, camelCased
 * ({constraint, namespace, layer, layerName, document, at, ids, value?,
 * parts?}), or null for any other error. The answer lists at most 100, and
 * `err.responseData["violation-count"]` is the total.
 * @param {any} err
 * @returns {Array<object>|null}
 */
export function violationsOf(err) {
  const vs = err?.status === 422 ? err?.responseData?.violations : undefined;
  return Array.isArray(vs) ? transformResponse(vs) : null;
}

/** The request body of a constraint write: the list, and `expected` when given. */
export function constraintsBody(constraints, options) {
  const body = constraints === undefined ? {} : { constraints };
  if (options && Object.hasOwn(options, "expected")) {
    body.expected = options.expected === undefined ? null : options.expected;
  }
  return body;
}
