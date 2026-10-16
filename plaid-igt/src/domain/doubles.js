// Where a field holds more than one annotation on a word, a morpheme or a
// sentence (REV5-WIRE-3): the server's own check of one annotation a unit
// names each such unit (its document, its first token and the annotations on
// it). A unit only on tokens Analyze shows no fields for (ignored tokens, or
// morphemes of them) cannot be reached there, so it is left out of every
// count and list (REV6-WIRE-5, REV7-WIRE-3): Validation's, the Put in force
// notice's and an import's.

// Relative imports only: an import's finish runs this from plain node too.
import { cpSlice } from '@larc-iu/plaid-client';
import { getIgtLayerInfo } from './layerInfo.js';
import { isTokenIgnored, readIgnoredTokens } from './igtConfig.js';

/** How many units Validation lists for a field. */
const SHOWN_DOUBLES = 20;

const countOf = (answer) =>
  answer?.violationCount ?? answer?.['violation-count'] ?? answer?.violations?.length ?? 0;

/**
 * One unit as Validation shows it, or null for a unit whose every token is
 * one Analyze shows no fields for. A unit over several tokens is shown at its
 * first word that is not ignored (core names it by its first token).
 */
const rowOf = (v, raw, layerId) => {
  const info = getIgtLayerInfo(raw);
  const text = info.primaryTextLayer;
  const body = text?.text?.body ?? '';
  const tokenLayers = text?.tokenLayers || [];
  const tokens = new Map(tokenLayers.flatMap((tl) => tl.tokens || []).map((t) => [t.id, t]));
  const spans = tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .find((sl) => sl.id === layerId)?.spans;
  const ids = new Set(v.ids || []);
  const doubled = (spans || []).filter((s) => ids.has(s.id));
  const words = info.primaryTokenLayer?.tokens || [];
  const ignored = readIgnoredTokens(info.primaryTokenLayer?.config);
  const wordOf = (token) =>
    words.find((w) => w.id === token.id || (w.begin <= token.begin && token.end <= w.end));
  const reachable = (token) => {
    const word = wordOf(token);
    return !word || !isTokenIgnored(cpSlice(body, word.begin, word.end), ignored);
  };
  // The unit's tokens in text order, its named first token first.
  const unit = [
    ...new Set([v.at, ...doubled.flatMap((s) => s.tokens || [])].filter((id) => tokens.has(id))),
  ]
    .map((id) => tokens.get(id))
    .sort((a, b) => (a.id === v.at ? -1 : b.id === v.at ? 1 : a.begin - b.begin));
  if (!unit.length) {
    return { docId: v.document, docName: raw?.name || '(untitled)', sentenceId: null, begin: null };
  }
  const token = unit.find(reachable);
  if (!token) return null;
  const sentence = (info.sentenceTokenLayer?.tokens || []).find(
    (s) => s.id === token.id || (s.begin <= token.begin && token.begin < s.end),
  );
  // A morpheme spans its word: its own form beside the word's text.
  const extent = cpSlice(body, token.begin, token.end);
  const own =
    token.metadata && Object.hasOwn(token.metadata, 'form') ? (token.metadata.form ?? '') : null;
  return {
    docId: v.document,
    docName: raw?.name || '(untitled)',
    sentenceId: sentence?.id ?? null,
    begin: token.begin,
    form: own !== null && own !== extent ? `${extent} · ${own}` : extent,
    values: doubled.map((s) => s.value),
  };
};

/**
 * The units of span layer `layerId` holding more than one annotation:
 * `{count, hidden, rows}`, `count` all of them but those Analyze cannot
 * reach, `hidden` how many of those it left out,
 * `rows` the first `limit` of those as `{docId, docName, sentenceId, begin,
 * form, values}` in document and text order (`sentenceId` the sentence the
 * unit is in, `form` its text, and a morpheme's own form after its word's).
 * Every document holding a unit core lists is read once.
 */
export const findDoubles = async (client, layerId, { limit = SHOWN_DOUBLES } = {}) => {
  const answer = await client.spanLayers.checkConstraints(layerId, [{ type: 'single-span' }]);
  const found = (answer?.violations || []).filter(
    (v) => v.constraint === 'single-span' && v.document && v.at,
  );
  const docs = new Map();
  const rows = [];
  let count = 0;
  let hidden = 0;
  for (const v of found) {
    if (!docs.has(v.document)) docs.set(v.document, await client.documents.get(v.document, true));
    const row = rowOf(v, docs.get(v.document), layerId);
    if (!row) {
      hidden += 1;
      continue;
    }
    count += 1;
    if (rows.length < limit) rows.push(row);
  }
  rows.sort(
    (a, b) =>
      a.docName.localeCompare(b.docName) ||
      (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0) ||
      (a.begin ?? 0) - (b.begin ?? 0),
  );
  // Core lists at most 100 units: those past it are counted as it counts
  // them, since which tokens they are on is not known here.
  return { count: count + Math.max(0, countOf(answer) - found.length), hidden, rows };
};
