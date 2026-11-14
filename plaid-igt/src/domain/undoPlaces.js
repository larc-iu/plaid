// Where a row an undo leaves can be shown, for the Undo dialog's lists: a
// place is `{key, label, to}` (`to` an address, or null), and null is a row
// that cannot be placed. Rows are core's (`client.audit.undo`'s `skipped`):
// `{kind, id, document | vocabLayer}`.

import { APP_ROUTES } from '@/appRoutes.js';

const idOf = (t) => (t && typeof t === 'object' ? t.id : t);

/**
 * In a document's History: a row in a sentence of the document now
 * (`doc`, the live IgtDocument) is placed at that sentence, "Sentence 3", a
 * link into the grid. The text and the document's own row are placed at the
 * tabs that show them. A row not in the document now (deleted since) is not
 * placed.
 */
export const documentPlacer = (doc, { projectId, documentId }) => {
  const tokens = new Map();
  const spanTokens = new Map();
  const relationSpan = new Map();
  for (const tl of doc?.raw?.textLayers || []) {
    for (const tkl of tl.tokenLayers || []) {
      for (const t of tkl.tokens || []) tokens.set(t.id, t);
      for (const sl of tkl.spanLayers || []) {
        for (const s of sl.spans || []) spanTokens.set(s.id, (s.tokens || []).map(idOf));
        for (const rl of sl.relationLayers || []) {
          for (const r of rl.relations || []) relationSpan.set(r.id, idOf(r.source));
        }
      }
    }
  }
  const linkTokens = new Map();
  for (const v of Object.values(doc?.vocabularies || {})) {
    for (const l of v.vocabLinks || []) linkTokens.set(l.id, (l.tokens || []).map(idOf));
  }
  const sentences = doc?.sortedSentences || [];
  const number = new Map(sentences.map((s, i) => [s.id, i + 1]));
  const base = APP_ROUTES.document(projectId, documentId);

  const tokensOf = (row) => {
    if (row.kind === 'token') return [row.id];
    if (row.kind === 'span') return spanTokens.get(row.id);
    if (row.kind === 'vocab-link') return linkTokens.get(row.id);
    if (row.kind === 'relation') return spanTokens.get(relationSpan.get(row.id));
    return null;
  };

  return (row) => {
    if (row.kind === 'text') return { key: 'text', label: 'Text', to: `${base}?tab=baseline` };
    if (row.kind === 'document') {
      return { key: 'document', label: 'Name and fields', to: `${base}?tab=details` };
    }
    for (const id of tokensOf(row) || []) {
      const s = number.has(id) ? { id } : doc?.findSentenceForToken?.(tokens.get(id));
      if (s && number.has(s.id)) {
        return {
          key: s.id,
          label: `Sentence ${number.get(s.id)}`,
          to: APP_ROUTES.sentence(projectId, documentId, s.id),
        };
      }
    }
    return null;
  };
};

/**
 * In a vocabulary's History: an entry is placed at itself, by the name
 * `entryName(id)` gives (its form in the entry's rows), a link to it in its
 * vocabulary. A link in a document is placed at its document, by the name and
 * project `documentOf(id)` gives (null while unread or unreadable: then
 * unnamed, with no link). The vocabulary's own row is placed at it.
 */
export const vocabularyPlacer = ({ vocabularyId, vocabularyName, entryName, documentOf }) => {
  return (row) => {
    if (row.kind === 'vocab-item') {
      const vocab = row.vocabLayer ?? vocabularyId;
      return {
        key: row.id,
        label: entryName(row.id) || 'Entry',
        to: `/vocabularies/${vocab}?item=${encodeURIComponent(row.id)}`,
      };
    }
    if (row.kind === 'vocab-layer') {
      return { key: row.id, label: vocabularyName || 'Vocabulary', to: `/vocabularies/${row.id}` };
    }
    if (row.document) {
      const d = documentOf(row.document);
      return {
        key: row.document,
        label: d?.name || 'Document',
        to: d ? APP_ROUTES.document(d.project, row.document) : null,
      };
    }
    return null;
  };
};
