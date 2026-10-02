/**
 * Layer constraints: rules an app declares on the token, span and relation
 * layers it owns, which the server enforces inside every write. A write that
 * breaks one on a row it writes is refused with 422 and the violations. See
 * the core manual, "Layer constraints".
 */

import { transformResponse } from "./transforms.js";

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

// What String.prototype.trim trims. The server trims a value-set's parts the
// same way, so a value read as listed here is read so there.
const splitParts = (value, delimiters) => {
  const set = new Set([...(delimiters || "")]);
  if (!set.size) return [value];
  const out = [];
  let part = "";
  for (const ch of value) {
    if (set.has(ch)) {
      out.push(part);
      part = "";
    } else {
      part += ch;
    }
  }
  out.push(part);
  return out;
};

/**
 * Whether a value-set constraint ({values, delimiters?, parts?}) allows
 * `value` as the server reads it: null and blank values pass, a non-string
 * does not, and every part split on a delimiter (or only the first, with
 * `parts: "first"`), trimmed, must be listed.
 * @param {{values: string[], delimiters?: string, parts?: "all"|"first"}} constraint
 * @param {any} value
 * @returns {boolean}
 */
export function valueSetAllows(constraint, value) {
  if (value == null) return true;
  if (typeof value !== "string") return false;
  if (value.trim() === "") return true;
  const delimiters = constraint?.delimiters || "";
  const values = constraint?.values || [];
  const parts = splitParts(value, delimiters);
  if (constraint?.parts === "first") {
    const firsts = new Set(values.map((v) => splitParts(v, delimiters)[0].trim()));
    return firsts.has(parts[0].trim());
  }
  const allowed = new Set(values);
  return parts.every((p) => p.trim() !== "" && allowed.has(p.trim()));
}
