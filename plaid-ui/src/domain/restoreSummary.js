// Restoring a document to an earlier state: what the server's dry run says
// would change, said in words, plus the small pieces the confirm dialog needs
// around it.
//
// The summary counts changes per table, broken down by layer. Naming a layer is
// what makes the list readable: a token layer is named by its shared ROLE, in
// the words the app that shows it uses for that role, and a span or relation
// layer by the name the project gave it.
//
// Dependency-free on purpose. plaid-ud's `node --test` suite loads this by real
// relative path, and neither the `@ui` alias nor the package's own dependencies
// resolve there, so the two things only the client knows are ARGUMENTS: an app
// hands over `readRole` and the words it calls each role by (see the app's own
// domain/restoreSummary.js).

import { humanizeError } from '../lib/errors.js';
import { fullTimestamp } from '../lib/formatTime.js';

const plural = (n, word, words = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : words}`;

const changed = (c) => (c?.inserted ?? 0) + (c?.updated ?? 0) + (c?.deleted ?? 0);

const SKIPPED_WORDS = {
  text: ['text', 'texts'],
  token: ['token', 'tokens'],
  span: ['annotation', 'annotations'],
  relation: ['relation', 'relations'],
  'vocab-link': ['vocabulary link', 'vocabulary links'],
};

// Every layer of the raw document by id, with what to call it. Token layers
// carry their role so the lines can use the app's words for them; a layer from
// another app sharing the substrate has no role this app knows, and falls back
// to its own name.
//
// `layerWords`, for an app with words of its own for its own layers, takes a
// layer's config to its [singular, plural], or to null to leave the layer out
// of the list, or to undefined for the general words. UMR counts a node once,
// as a node, and not again by the token that anchors it.
export const indexLayers = (raw, readRole, layerWords) => {
  const out = {};
  const entry = (layer, extra) => {
    const e = { name: layer.name, ...extra };
    const words = layerWords?.(layer.config);
    if (words !== undefined) e.words = words;
    return e;
  };
  for (const tl of raw?.textLayers || []) {
    for (const tkl of tl.tokenLayers || []) {
      out[tkl.id] = entry(tkl, { role: readRole(tkl.config) });
      for (const sl of tkl.spanLayers || []) {
        out[sl.id] = entry(sl);
        for (const rl of sl.relationLayers || []) out[rl.id] = entry(rl);
      }
    }
  }
  return out;
};

// One line per kind of change, in the order the document is built.
// `roleWords` maps a token layer's role to its [singular, plural].
export const changeLines = (summary, layers = {}, roleWords = {}) => {
  if (!summary) return [];
  const lines = [];
  if (summary.name) lines.push('The document name');
  // Not just "The text": a word is a slice of the body, so restoring the text
  // changes what the words read while their own rows are untouched and counted
  // nowhere below. An equal-length respell is the whole of such a restore, and
  // this line was all a reader got for ten words coming back.
  if (changed(summary.texts)) lines.push('The text, and the words read from it');
  for (const e of summary.tokens?.byLayer || []) {
    const n = changed(e);
    const layer = layers[e.layerId];
    if (!n || layer?.words === null) continue;
    const words = layer?.words || roleWords[layer?.role];
    lines.push(
      words ? plural(n, ...words) : `${plural(n, 'token')} in ${layer?.name ?? 'a layer'}`,
    );
  }
  for (const e of summary.spans?.byLayer || []) {
    const n = changed(e);
    const layer = layers[e.layerId];
    if (!n || layer?.words === null) continue;
    lines.push(
      layer?.words
        ? plural(n, ...layer.words)
        : `${plural(n, 'annotation')} in ${layer?.name ?? 'a field'}`,
    );
  }
  for (const e of summary.relations?.byLayer || []) {
    const n = changed(e);
    const layer = layers[e.layerId];
    if (!n || layer?.words === null) continue;
    lines.push(
      layer?.words
        ? plural(n, ...layer.words)
        : `${plural(n, 'relation')} in ${layer?.name ?? 'a layer'}`,
    );
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

// The audit message a restore is written under.
export const historyMessage = (asOf, label) =>
  `Restore to ${fullTimestamp(asOf)}` + (label ? ` (after “${label}”)` : '');

// A 409 from the restore is the server saying the old state no longer fits a
// layer as it is now, and it says which one, so it passes through verbatim.
// Anything else reads as it does everywhere.
export const restoreError = (err, fallback) => {
  const m = String(err?.message || '');
  if (/no longer fits/.test(m)) {
    return m.replace(/^HTTP \d+\s*/, '').replace(/\s*at\s+https?:\/\/\S+/, '');
  }
  return humanizeError(err, fallback);
};

// The document's newest history entry: the moment its live state belongs to,
// and what that entry is called, or null for a document with no history. Read
// BEFORE a restore so the state from just before it can be brought back.
export const latestState = async (client, documentId) => {
  const entries = await client.documents.audit(documentId);
  const last = entries?.[entries.length - 1];
  if (!last) return null;
  return {
    time: last.endTime || last.time,
    label: last.message || last.ops?.[0]?.description || null,
  };
};
