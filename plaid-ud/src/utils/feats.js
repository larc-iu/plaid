// A FEATS pair, read the same way by everyone who writes one.
//
// CoNLL-U's own rule ("Fields other than FORM, LEMMA, and MISC must not contain
// space characters") means a feature's name and its value are both space-free.
// So the whitespace around a typed pair carries no meaning and is dropped here,
// and whitespace left INSIDE either half is something the FEATS column of an
// export could not spell.
//
// Every writer goes through this file: the FEATS cell, the document's features
// write, and the CoNLL-U import. They used to each read the pair their own way,
// and the cell trimmed the pair's two ends while the document keyed the write on
// the untrimmed name, so a typed `Gender =Fem` filed itself under `Gender ` and
// left the word carrying two genders.

/**
 * Read a `Key=Value` pair, trimming BOTH halves.
 *
 * @param {*} raw the typed or imported pair
 * @returns {{key: string, value: string, pair: string}|null} null when there is
 *   no complete pair: no `=`, or a half that is empty once trimmed.
 */
export const normalizeFeature = (raw) => {
  const text = String(raw ?? '');
  const eq = text.indexOf('=');
  if (eq === -1) return null;
  const key = text.slice(0, eq).trim();
  const value = text.slice(eq + 1).trim();
  if (!key || !value) return null;
  return { key, value, pair: `${key}=${value}` };
};

/**
 * What is wrong with a normalized pair, or null when nothing is. A space inside
 * either half is the one case, and it is fatal rather than fixable here: only
 * the person typing knows whether `Fem Masc` was two features or a typo.
 *
 * @param {string} pair a pair from normalizeFeature
 * @returns {string|null}
 */
export const featureRefusal = (pair) =>
  /\s/.test(pair) ? 'A feature name and value cannot contain spaces.' : null;
