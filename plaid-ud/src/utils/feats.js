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

// By its real path: the `node --test` suite has no `@ui` alias.
import { msg, t } from '../../../plaid-ui/src/lib/i18n.js';

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
 * either half is fatal rather than fixable here: only the person typing knows
 * whether `Fem Masc` was two features or a typo. So is a `|`, the FEATS
 * column's own separator: `Case=Nom|Gender=Masc` read as one pair files
 * Gender inside Case's value, where the one-value-per-name rule never sees it
 * and the export writes a second Gender beside it (H17-1).
 *
 * @param {string} pair a pair from normalizeFeature
 * @returns {string|null}
 */
export const featureRefusal = (pair) =>
  /\s/.test(pair)
    ? t('A feature name and value cannot contain spaces.')
    : pair.includes('|')
      ? t('A feature name and value cannot contain |.')
      : null;

// The same CoNLL-U rule for the other columns a person types into. Only the
// fields it covers: a lemma or a form may hold a space (H17-3).
const SPACE_FREE = {
  upos: msg('A UPOS value cannot contain spaces.'),
  xpos: msg('An XPOS value cannot contain spaces.'),
  deprel: msg('A dependency relation cannot contain spaces.'),
};

/**
 * The refusal for a UPOS, XPOS or dependency relation value with a space in
 * it, or null. Any other field, or no value, is never refused here.
 *
 * @param {string} field upos, xpos or deprel
 * @param {*} value the value about to be written
 * @returns {string|null}
 */
export const spaceRefusal = (field, value) =>
  SPACE_FREE[field] && typeof value === 'string' && /\s/.test(value)
    ? t(SPACE_FREE[field])
    : field === 'deprel' && typeof value === 'string' && /^:|:$|::/.test(value)
      ? // An empty part ('nmod:', 'obl::', ':poss'), which a closed list,
        // reading only the part before the first colon, let through (H3-1-3).
        t('A dependency relation cannot start or end with a colon, or hold two in a row.')
      : null;
