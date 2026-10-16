// Where a field holds more than one annotation on a word, a morpheme or a
// sentence, for the Validation tab's notice (REV5-WIRE-3): the server's own
// check of one annotation a unit names each such unit (its document, its
// token and the annotations on it), and the documents that hold the first
// few are loaded to show the unit and its values.

import { cpSlice } from '@larc-iu/plaid-client';
import { getIgtLayerInfo } from '@/domain/layerInfo';

/** How many units the notice lists for a field. */
const SHOWN_DOUBLES = 20;

const countOf = (answer) =>
  answer?.violationCount ?? answer?.['violation-count'] ?? answer?.violations?.length ?? 0;

/**
 * The units of span layer `layerId` holding more than one annotation:
 * `{count, rows}`, `count` all of them, `rows` the first `limit` as
 * `{docId, docName, sentenceId, begin, form, values}` in document and text
 * order (`sentenceId` the sentence the unit is in, `form` its text, and a
 * morpheme's own form after its word's).
 */
export const locateDoubles = async (client, layerId, { limit = SHOWN_DOUBLES } = {}) => {
  const answer = await client.spanLayers.checkConstraints(layerId, [{ type: 'single-span' }]);
  const found = (answer?.violations || []).filter(
    (v) => v.constraint === 'single-span' && v.document && v.at,
  );
  const shown = found.slice(0, limit);
  const docIds = [...new Set(shown.map((v) => v.document))];
  const docs = new Map(
    await Promise.all(docIds.map(async (id) => [id, await client.documents.get(id, true)])),
  );
  const rows = shown.map((v) => {
    const raw = docs.get(v.document);
    const info = getIgtLayerInfo(raw);
    const text = info.primaryTextLayer;
    const tokenLayers = text?.tokenLayers || [];
    const token = tokenLayers.flatMap((tl) => tl.tokens || []).find((t) => t.id === v.at);
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
    const extent = token ? cpSlice(text?.text?.body ?? '', token.begin, token.end) : '';
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
  });
  rows.sort(
    (a, b) =>
      a.docName.localeCompare(b.docName) ||
      (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0) ||
      (a.begin ?? 0) - (b.begin ?? 0),
  );
  return { count: Math.max(countOf(answer), found.length), rows };
};
