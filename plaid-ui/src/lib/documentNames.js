// Document names are unique in a project, ignoring case. Core refuses a
// create, rename or copy to a name another document of the project holds
// (422, `name-taken`),
// and a copy or an import may ask core for the first free name instead
// (`freeName`). The same order as core's `plaid.sql.document-names`.

import { statusOf } from './errors.js';
import { nameKey } from './nameKey.js';

/** The names a document named `name` may take, in order: `name`, then
 * "name (2)", "name (3)" and on. */
function* nameCandidates(name) {
  yield name;
  for (let n = 2; ; n += 1) yield `${name} (${n})`;
}

// A name as core compares names (`plaid.sql.document-names/fold`): full case
// folding, upper then lower case with ß as ss, composed.
const fold = (name) => nameKey(nameKey(name).toUpperCase().toLowerCase().replaceAll('ß', 'ss'));

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
