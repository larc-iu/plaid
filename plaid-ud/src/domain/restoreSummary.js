// Turns the server's restore summary (documents.restore with dryRun) into the
// lines the confirm dialog lists. Kept JSX-free and side-effect-free so the
// node test suite can drive it directly.
//
// The summary counts changes per table, broken down by layer. Naming a layer
// is what makes the list readable: a token layer is named by its shared ROLE
// (in UD terms), a span or relation layer by the name the project gave it.

import { ROLES, readRole } from '@larc-iu/plaid-client';

const plural = (n, word, words = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : words}`;

const changed = (c) => (c?.inserted ?? 0) + (c?.updated ?? 0) + (c?.deleted ?? 0);

// UD terminology: the `word`-role layer holds orthographic TOKENS and the
// `syntactic-word`-role layer holds WORDS. See the UI terminology convention —
// this is the user-facing half, so it does not follow the internal names.
const TOKEN_ROLE_WORDS = {
  [ROLES.SENTENCE]: ['sentence', 'sentences'],
  [ROLES.WORD]: ['token', 'tokens'],
  [ROLES.SYNTACTIC_WORD]: ['word', 'words'],
};

const SKIPPED_WORDS = {
  text: ['text', 'texts'],
  token: ['token', 'tokens'],
  span: ['annotation', 'annotations'],
  relation: ['relation', 'relations'],
  'vocab-link': ['vocabulary link', 'vocabulary links'],
};

// Every layer of the raw document by id, with what to call it. Token layers
// carry their role so the lines can use UD's words for them; a layer from
// another app sharing the substrate has no role we know, and falls back to
// its own name.
export const indexLayers = (raw) => {
  const out = {};
  for (const tl of raw?.textLayers || []) {
    for (const tkl of tl.tokenLayers || []) {
      out[tkl.id] = { name: tkl.name, role: readRole(tkl.config) };
      for (const sl of tkl.spanLayers || []) {
        out[sl.id] = { name: sl.name };
        for (const rl of sl.relationLayers || []) out[rl.id] = { name: rl.name };
      }
    }
  }
  return out;
};

// One line per kind of change, in the order the document is built.
export const changeLines = (summary, layers = {}) => {
  if (!summary) return [];
  const lines = [];
  if (summary.name) lines.push('The document name');
  if (changed(summary.texts)) lines.push('The text');
  for (const e of summary.tokens?.byLayer || []) {
    const n = changed(e);
    if (!n) continue;
    const layer = layers[e.layerId];
    const words = TOKEN_ROLE_WORDS[layer?.role];
    lines.push(
      words ? plural(n, ...words) : `${plural(n, 'token')} in ${layer?.name ?? 'a layer'}`,
    );
  }
  for (const e of summary.spans?.byLayer || []) {
    const n = changed(e);
    if (n) lines.push(`${plural(n, 'annotation')} in ${layers[e.layerId]?.name ?? 'a field'}`);
  }
  for (const e of summary.relations?.byLayer || []) {
    const n = changed(e);
    if (n) lines.push(`${plural(n, 'relation')} in ${layers[e.layerId]?.name ?? 'a layer'}`);
  }
  if (changed(summary.vocabLinks)) {
    lines.push(plural(changed(summary.vocabLinks), 'vocabulary link'));
  }
  if (summary.documentMetadata) lines.push('Metadata');
  return lines;
};

// What the restore cannot bring back: its layer is gone, or a vocabulary entry
// it pointed at no longer exists.
export const skippedLines = (skipped) =>
  (skipped || []).map(
    (k) => `${plural(k.count, ...(SKIPPED_WORDS[k.kind] || ['item', 'items']))} cannot come back.`,
  );
