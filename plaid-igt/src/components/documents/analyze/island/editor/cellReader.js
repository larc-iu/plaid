import { settledId } from '@ui/domain/pendingIds.js';
import { morphFormOf } from './shared.js';

// What is stored under a grid cell, read from the document and never from the
// cell, for the cell engine (plaid-ui cells/CellEngine.js). A cell on a page
// that is not drawn is read the same way as a drawn one.
//
// A cell key is `<kind>:<id>:<field>`, or `mf:<id>` for a morpheme's form:
// `or` a word's orthography, `wa` a word's annotation, `ma` a morpheme's,
// `sa` a sentence's. The id may itself hold a colon (`virtual:<word>`,
// `pending:<n>`), and so may the field. Each value is read with the same
// accessor the grid draws it with (grid.js), over the same sentences, words
// and morphemes, so an unanalyzed word's morpheme is there by the same
// derivation.

// The row a cell key names.
const rowOfKey = (key) => {
  const rest = (key ?? '').slice(key.indexOf(':') + 1);
  return /^(virtual:[^:]+|pending:\d+|[^:]+)/.exec(rest)?.[1] ?? '';
};

const partsOf = (key) => {
  const kind = key.slice(0, key.indexOf(':'));
  const row = rowOfKey(key);
  const field = key.slice(kind.length + 1 + row.length + 1);
  return { kind, row: settledId(row), field };
};

// Every sentence, word and morpheme by id, and each morpheme's word, once per
// data version of a document.
const indexes = new WeakMap();
const indexOf = (doc) => {
  const hit = indexes.get(doc);
  if (hit && hit.version === doc.dataVersion) return hit;
  const index = {
    version: doc.dataVersion,
    sentences: new Map(),
    words: new Map(),
    morphemes: new Map(),
    wordOf: new Map(),
  };
  for (const sentence of doc.sentences || []) {
    index.sentences.set(sentence.id, sentence);
    for (const token of sentence.tokens || []) {
      index.words.set(token.id, token);
      for (const morph of token.morphemes || []) {
        index.morphemes.set(morph.id, morph);
        index.wordOf.set(morph.id, token);
      }
    }
  }
  indexes.set(doc, index);
  return index;
};

// The row a key names and the value under it, or null for a row that is gone.
const cellOf = (doc, key) => {
  const { kind, row, field } = partsOf(key);
  const index = indexOf(doc);
  if (kind === 'or' || kind === 'wa') {
    const word = index.words.get(row);
    if (!word) return null;
    return kind === 'or'
      ? { value: word.orthographies?.[field] ?? '', ids: [word.id] }
      : { value: word.annotations?.[field]?.value ?? '', ids: [word.annotations?.[field]?.id] };
  }
  if (kind === 'ma' || kind === 'mf') {
    const morph = index.morphemes.get(row);
    if (!morph) return null;
    return kind === 'mf'
      ? { value: morphFormOf(morph), ids: [morph.id] }
      : { value: morph.annotations?.[field]?.value ?? '', ids: [morph.annotations?.[field]?.id] };
  }
  if (kind === 'sa') {
    const sentence = index.sentences.get(row);
    if (!sentence) return null;
    return {
      value: sentence.annotations?.[field]?.value ?? '',
      ids: [sentence.annotations?.[field]?.id],
    };
  }
  return null;
};

/** The value stored under the cell `key` names, or undefined when its row is gone. */
export const readCell = (doc, key) => cellOf(doc, key)?.value;

/** The ids of what the cell `key` names writes, as stored now. */
export const cellEntityIds = (doc, key) => (cellOf(doc, key)?.ids ?? []).filter(Boolean);

// The text of a sentence as it reads now, or null when it is gone.
const sentenceTextNow = (doc, sentenceId) => {
  const sentence = doc.sentenceLookup?.get(settledId(sentenceId));
  const body = doc.layerInfo?.primaryTextLayer?.text?.body;
  if (!sentence || typeof body !== 'string') return null;
  return [...body].slice(sentence.begin, sentence.end).join('').trim();
};

// The word `wordId` as it reads now, and the form of its morpheme `rowId`
// when the row is one of its morphemes. A morpheme is re-segmented in its
// form, the text its cell shows, and keeps its id and extent ("sing" to si-ng
// leaves "si" on the same token).
const wordNow = (doc, wordId, rowId) => {
  const word = doc.tokenLookup?.get(settledId(wordId));
  if (!word) return null;
  const morpheme =
    rowId && rowId !== wordId
      ? (word.morphemes || []).find((m) => settledId(m.id) === settledId(rowId))
      : null;
  return { word: word.content, morpheme: morpheme ? morphFormOf(morpheme) : null };
};

/**
 * What the value of the cell `key` is typed for, as it reads now: the word
 * it is on, and its morpheme's form for a morpheme's cell. For a sentence's
 * cell, the sentence and its text. Null when there is nothing to tell.
 */
export const shapeOf = (doc, key) => {
  const { kind, row } = partsOf(key);
  if (kind === 'sa') {
    const sentence = sentenceTextNow(doc, row);
    return sentence == null ? null : { sentenceId: row, sentence };
  }
  const word = kind === 'or' || kind === 'wa' ? row : indexOf(doc).wordOf.get(row)?.id;
  if (!word) return null;
  const now = wordNow(doc, word, row);
  return now && { wordId: word, rowId: row, ...now };
};

/**
 * What the cell is on now, as `{ unit, text }`, when the word under `shape`
 * was split or joined since (its text changed), or its morpheme re-segmented
 * (its form changed), or its sentence split, joined or respelled, else null.
 */
export const recutOf = (doc, shape) => {
  if (!shape) return null;
  if (shape.sentenceId) {
    const text = sentenceTextNow(doc, shape.sentenceId);
    return text != null && text !== shape.sentence ? { unit: 'sentence', text } : null;
  }
  const now = wordNow(doc, shape.wordId, shape.rowId);
  if (!now) return null;
  if (now.word !== shape.word) return { unit: 'word', text: now.word };
  if (shape.morpheme != null && now.morpheme != null && now.morpheme !== shape.morpheme) {
    return { unit: 'morpheme', text: now.morpheme };
  }
  return null;
};
