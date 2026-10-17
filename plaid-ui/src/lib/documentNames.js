// Document names are unique in a project, ignoring case. Core refuses a
// create, rename or copy to a name another document of the project holds
// (422, `name-taken`),
// and a copy or an import may ask core for the first free name instead
// (`freeName`). The same order as core's `plaid.sql.document-names`.

import { statusOf } from './errors.js';
import { CASE_FOLD_TABLE, UNASSIGNED_TABLE } from './caseFoldTable.js';
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

let unassigned = null;
const unassignedRanges = () => {
  if (!unassigned) {
    unassigned = UNASSIGNED_TABLE.split('\n')
      .filter(Boolean)
      .map((line) => line.split('-').map((h) => parseInt(h, 16)));
  }
  return unassigned;
};
// Whether core's Unicode version leaves code point `cp` unassigned.
const unassignedInCore = (cp) => {
  const ranges = unassignedRanges();
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
};

// `s` composed as core composes it: a code point core's Unicode version
// leaves unassigned stays as it is and composes with nothing, where this
// browser's newer Unicode may compose it (Tulu-Tigalari, Kirat Rai, Todhri in
// Unicode 16), so two names core keeps apart stay apart here (REV8-CORE-5).
const nfcAsCore = (s) => {
  let out = '';
  let piece = '';
  for (const ch of s) {
    if (unassignedInCore(ch.codePointAt(0))) {
      out += piece.normalize('NFC') + ch;
      piece = '';
    } else {
      piece += ch;
    }
  }
  return out + piece.normalize('NFC');
};

// A name as core compares names (`plaid.sql.document-names/fold`): composed,
// then Python's `str.casefold` code point by code point, composed again, by
// core's Unicode version (caseFoldTable.js).
export const foldDocumentName = (name) => {
  const folds = caseFoldsMap();
  let out = '';
  for (const ch of nfcAsCore(String(name ?? ''))) out += folds.get(ch.codePointAt(0)) ?? ch;
  return nfcAsCore(out);
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
