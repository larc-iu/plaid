// Promoted examples. An example is a reference into a document, `{document,
// token}`, so showing one means reading the sentence that token sits in.
//
// The reading is plaid-igt's: IgtDocument derives the sentences, and
// buildContextRows slices the sentence text and pulls its translation. That is
// the same pair of numbers the LIFT export writes, so an example reads here
// exactly as it does in a file the compiler sends out.
//
// A form page needs a handful of documents at most, and a reader moving through
// a dictionary comes back to the same texts, so derived documents are kept for
// the session.
//
// This module pulls in IgtDocument and everything under it, which no other
// screen needs, so it is loaded on demand rather than up front.

import { IgtDocument } from '@igt/domain/IgtDocument.js';
import { buildContextRows } from '@igt/components/projects/search/searchRunner.js';
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
      for (const row of buildContextRows(doc, { kind: 'lexicon' }, tokenIds)) {
        for (const tokenId of row.tokenIds || []) {
          if (tokenIds.has(tokenId)) {
            sentences.set(exampleKey(documentId, tokenId), {
              text: row.text,
              translation: row.translation,
            });
          }
        }
      }
    }),
  );
  return sentences;
};
