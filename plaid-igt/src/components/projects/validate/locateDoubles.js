// Where a field holds more than one annotation on a word, a morpheme or a
// sentence, for the Validation tab's notice (REV5-WIRE-3): the server's own
// check of one annotation a unit names each such unit (its document, its
// token and the annotations on it), and the documents that hold the first
// few are loaded to show the unit and its values.

import { cpSlice } from '@larc-iu/plaid-client';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { isTokenIgnored, readIgnoredTokens } from '@/domain/igtConfig';

/** How many units the notice lists for a field. */
const SHOWN_DOUBLES = 20;

const countOf = (answer) =>
  answer?.violationCount ?? answer?.['violation-count'] ?? answer?.violations?.length ?? 0;

/**
 * One unit as the notice shows it, or null for a unit on a token Analyze
 * shows no fields for (an ignored token, or a morpheme of one), whose
 * annotations cannot be reached there (REV6-WIRE-5).
 */
const rowOf = (v, raw, layerId) => {
  const info = getIgtLayerInfo(raw);
  const text = info.primaryTextLayer;
  const body = text?.text?.body ?? '';
  const tokenLayers = text?.tokenLayers || [];
  const token = tokenLayers.flatMap((tl) => tl.tokens || []).find((t) => t.id === v.at);
  const word = token
    ? (info.primaryTokenLayer?.tokens || []).find(
        (w) => w.id === token.id || (w.begin <= token.begin && token.end <= w.end),
      )
    : null;
  const ignored = readIgnoredTokens(info.primaryTokenLayer?.config);
  if (word && isTokenIgnored(cpSlice(body, word.begin, word.end), ignored)) return null;
  const sentence = token
    ? (info.sentenceTokenLayer?.tokens || []).find(
        (s) => s.id === token.id || (s.begin <= token.begin && token.begin < s.end),
      )
    : null;
  const spans = tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .find((sl) => sl.id === layerId)?.spans;
  const ids = new Set(v.ids || []);
  // A morpheme spans its word: its own form beside the word's text.
  const extent = token ? cpSlice(body, token.begin, token.end) : '';
  const own =
    token?.metadata && Object.hasOwn(token.metadata, 'form') ? (token.metadata.form ?? '') : null;
  return {
    docId: v.document,
    docName: raw?.name || '(untitled)',
    sentenceId: sentence?.id ?? null,
    begin: token?.begin ?? null,
    form: own !== null && own !== extent ? `${extent} · ${own}` : extent,
    values: (spans || []).filter((s) => ids.has(s.id)).map((s) => s.value),
  };
};

/**
 * The units of span layer `layerId` holding more than one annotation:
 * `{count, rows}`, `count` all of them but those on tokens Analyze shows no
 * fields for, `rows` the first `limit` as `{docId, docName, sentenceId,
 * begin, form, values}` in document and text order (`sentenceId` the
 * sentence the unit is in, `form` its text, and a morpheme's own form after
 * its word's). With `projectId`, a document whose name another document of
 * the project shares is named with its id too, as the assistant's reads
 * name it: "Text 1 (019e…)".
 */
export const locateDoubles = async (
  client,
  layerId,
  { limit = SHOWN_DOUBLES, projectId = null } = {},
) => {
  const answer = await client.spanLayers.checkConstraints(layerId, [{ type: 'single-span' }]);
  const found = (answer?.violations || []).filter(
    (v) => v.constraint === 'single-span' && v.document && v.at,
  );
  // Documents are loaded as the units need them, until `limit` are shown.
  const docs = new Map();
  const rows = [];
  let skipped = 0;
  for (const v of found) {
    if (rows.length >= limit) break;
    if (!docs.has(v.document)) docs.set(v.document, await client.documents.get(v.document, true));
    const row = rowOf(v, docs.get(v.document), layerId);
    if (row) rows.push(row);
    else skipped += 1;
  }
  if (projectId && rows.length) {
    const named = new Map();
    for (const d of (await client.projects.listDocuments(projectId)) || []) {
      named.set(d.name, (named.get(d.name) ?? 0) + 1);
    }
    for (const r of rows) if ((named.get(r.docName) ?? 0) > 1) r.docName += ` (${r.docId})`;
  }
  rows.sort(
    (a, b) =>
      a.docName.localeCompare(b.docName) ||
      (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0) ||
      (a.begin ?? 0) - (b.begin ?? 0),
  );
  return { count: Math.max(countOf(answer), found.length) - skipped, rows };
};
