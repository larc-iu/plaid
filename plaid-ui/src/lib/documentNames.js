// Document names are unique in a project, ignoring case. Core refuses a
// create, rename or copy to a name another document of the project holds
// (422, `name-taken`),
// and a copy or an import may ask core for the first free name instead
// (`freeName`). The same order as core's `plaid.sql.document-names`.

import { statusOf } from './errors.js';
import { CASE_FOLD_TABLE } from './caseFoldTable.js';
import { nameKey } from './nameKey.js';

/** The names a document named `name` may take, in order: `name`, then
 * "name (2)", "name (3)" and on. */
function* nameCandidates(name) {
  yield name;
  for (let n = 2; ; n += 1) yield `${name} (${n})`;
}

let caseFolds = null;
const caseFoldsMap = () => {
  if (!caseFolds) {
    caseFolds = new Map();
    for (const line of CASE_FOLD_TABLE.split('\n')) {
      if (!line) continue;
      const [cp, ...to] = line.split(' ').map((h) => parseInt(h, 16));
      caseFolds.set(cp, String.fromCodePoint(...to));
    }
  }
  return caseFolds;
};

// A name as core compares names (`plaid.sql.document-names/fold`): composed,
// then Python's `str.casefold` code point by code point, composed again.
export const foldDocumentName = (name) => {
  const folds = caseFoldsMap();
  let out = '';
  for (const ch of nameKey(name)) out += folds.get(ch.codePointAt(0)) ?? ch;
  return nameKey(out);
};
const fold = foldDocumentName;

/** The first of `nameCandidates(name)` none of `taken` (any iterable) holds
 * but for case, composed (NFC) as the server stores every name. */
export function freeDocumentName(name, taken) {
  const held = new Set([...taken].map(fold));
  for (const candidate of nameCandidates(nameKey(name))) {
    if (!held.has(fold(candidate))) return candidate;
  }
  return nameKey(name);
}

/** Core's message when `error` is its refusal of a taken name, else null. */
export function nameTakenMessage(error) {
  if (statusOf(error) !== 422) return null;
  const data = error?.responseData;
  if (data?.['name-taken'] == null) return null;
  return String(data.error || '').trim() || null;
}
