// Promoted examples. An example is a reference into a document, `{document,
// token}`, so showing one means reading the sentence that token sits in.
//
// The reading is plaid-igt's: IgtDocument derives the sentences and locateHits
// finds the token in them, the same machinery the LIFT export's example
// harvest uses, so an example reads here as it does in a file the compiler
// sends out. Unlike that harvest, this keeps EVERY sentence layer that has a
// value rather than the first, because which of them a dictionary shows is the
// compiler's choice (see exampleLayers.js). A layer with nothing in it for a
// given sentence is dropped here and so never reaches the page.
//
// A form page needs a handful of documents at most, and a reader moving through
// a dictionary comes back to the same texts, so derived documents are kept for
// the session.
//
// This module pulls in IgtDocument and everything under it, which no other
// screen needs, so it is loaded on demand rather than up front.

import { cpSlice } from '@larc-iu/plaid-client';
import { IgtDocument } from '@igt/domain/IgtDocument.js';
import { locateHits } from '@igt/components/projects/search/searchRunner.js';
import { exampleKey } from '@igt/domain/vocabDictionary.js';

const documents = new Map(); // document id -> Promise<IgtDocument>

const loadDocument = (client, documentId) => {
  if (!documents.has(documentId)) {
    const pending = (async () => {
      const raw = await client.documents.get(documentId, true);
      return new IgtDocument({ raw, vocabularies: {}, client });
    })();
    // A failed read must not be remembered as the answer: a document may be
    // unreadable now and readable on the next page.
    pending.catch(() => documents.delete(documentId));
    documents.set(documentId, pending);
  }
  return documents.get(documentId);
};

/**
 * The sentences behind a set of references, keyed by `exampleKey`. One read per
 * document however many examples point into it. A document that cannot be read,
 * or a token no longer in the one that can, simply yields nothing.
 */
export const resolveExamples = async (client, refs) => {
  const byDocument = new Map();
  for (const ref of refs || []) {
    if (!byDocument.has(ref.document)) byDocument.set(ref.document, new Set());
    byDocument.get(ref.document).add(ref.token);
  }
  const sentences = new Map();
  await Promise.all(
    [...byDocument.entries()].map(async ([documentId, tokenIds]) => {
      let doc;
      try {
        doc = await loadDocument(client, documentId);
      } catch {
        return; // unreadable or deleted: its examples are not shown
      }
      const sentenceLayers = doc.layerInfo?.spanLayers?.sentence || [];
      for (const row of locateHits(doc, { kind: 'lexicon' }, tokenIds)) {
        const sentence = row.sentence;
        const found = {
          text: cpSlice(doc.body || '', sentence.begin, sentence.end),
          lines: sentenceLayers
            .map((layer) => ({
              name: layer.name,
              value: sentence.annotations?.[layer.name]?.value ?? '',
            }))
            .filter((line) => line.value !== ''),
        };
        for (const tokenId of row.tokenIds || []) {
          if (tokenIds.has(tokenId)) sentences.set(exampleKey(documentId, tokenId), found);
        }
      }
    }),
  );
  return sentences;
};
