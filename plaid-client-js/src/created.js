/**
 * The ids a create answered with. A create's response is `{id}` and a bulk
 * create's is `{ids}`, read straight off the call or off its result in a
 * batch (`{status, body}`). Every reader of a create response goes through
 * these, so none guesses at the shape.
 */

const isId = (v) => typeof v === "string";

/**
 * The id a single create answered with, or undefined when it gave none.
 * @param {Object|null|undefined} result - the create's response, or its batch result
 * @returns {string|undefined}
 */
export const createdId = (result) => {
  if (isId(result?.id)) return result.id;
  return isId(result?.body?.id) ? result.body.id : undefined;
};

/**
 * The ids a bulk create answered with, in input order, or an empty array
 * when it gave none.
 * @param {Object|null|undefined} result - the bulk create's response, or its batch result
 * @returns {string[]}
 */
export const createdIds = (result) => {
  if (Array.isArray(result?.ids)) return result.ids;
  return Array.isArray(result?.body?.ids) ? result.body.ids : [];
};
