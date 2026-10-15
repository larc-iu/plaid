import { settledId } from '@ui/domain/pendingIds.js';
import { reshaped, neighboursAt } from '@ui/domain/cells/recut.js';
import { morphFormOf } from './shared.js';

// What is stored under a grid cell, read from the document and never from the
// cell, for the cell engine (plaid-ui cells/CellEngine.js). A cell on a page
// that is not drawn is read the same way as a drawn one.
//
// A cell key is `<kind>:<id>:<field>`, or `mf:<id>` for a morpheme's form:
// `or` a word's orthography, `wa` a word's annotation, `ma` a morpheme's,
// `sa` a sentence's. The id may itself hold a colon (`virtual:<word>`), and so
// may the field. Each value is read with the same
// accessor the grid draws it with (grid.js), over the same sentences, words
// and morphemes, so an unanalyzed word's morpheme is there by the same
// derivation.

// The row a cell key names.
const rowOfKey = (key) => {
  const rest = (key ?? '').slice(key.indexOf(':') + 1);
  return /^(virtual:[^:]+|[^:]+)/.exec(rest)?.[1] ?? '';
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
    // Sentences and words in reading order, and where each id is in it.
    sentenceOrder: doc.sentences || [],
    sentenceAt: new Map(),
    wordOrder: [],
    wordAt: new Map(),
  };
  for (const sentence of doc.sentences || []) {
    index.sentenceAt.set(settledId(sentence.id), index.sentenceAt.size);
    index.sentences.set(sentence.id, sentence);
    for (const token of sentence.tokens || []) {
      index.wordAt.set(settledId(token.id), index.wordOrder.length);
      index.wordOrder.push(token);
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

// The text of a sentence as it reads now, and the sentences beside it, or
// null when it is gone.
const sentenceNow = (doc, sentenceId) => {
  const sentence = doc.sentenceLookup?.get(settledId(sentenceId));
  const body = doc.layerInfo?.primaryTextLayer?.text?.body;
  if (!sentence || typeof body !== 'string') return null;
  const index = indexOf(doc);
  return {
    text: [...body].slice(sentence.begin, sentence.end).join('').trim(),
    ...neighboursAt(index.sentenceOrder, index.sentenceAt.get(settledId(sentenceId)) ?? -1),
  };
};

// The word `wordId` as it reads now, the words beside it, and the form of its
// morpheme `rowId` and the morphemes beside that when the row is one of its
// morphemes. A morpheme is re-segmented in its form, the text its cell shows,
// and keeps its id and extent ("sing" to si-ng leaves "si" on the same token).
const wordNow = (doc, wordId, rowId) => {
  const word = doc.tokenLookup?.get(settledId(wordId));
  if (!word) return null;
  const index = indexOf(doc);
  const morphemes = word.morphemes || [];
  const at =
    rowId && rowId !== wordId
      ? morphemes.findIndex((m) => settledId(m.id) === settledId(rowId))
      : -1;
  return {
    word: word.content,
    words: neighboursAt(index.wordOrder, index.wordAt.get(settledId(wordId)) ?? -1),
    morpheme: at >= 0 ? morphFormOf(morphemes[at]) : null,
    morphemes: neighboursAt(morphemes, at),
  };
};

/**
 * What the value of the cell `key` is typed for, as it reads now: the word
 * it is on, and its morpheme's form for a morpheme's cell. For a sentence's
 * cell, the sentence and its text. Each with the ids beside it, which tell a
 * split, join or merge from a respelling. Null when there is nothing to tell.
 */
export const shapeOf = (doc, key) => {
  const { kind, row } = partsOf(key);
  if (kind === 'sa') {
    const now = sentenceNow(doc, row);
    return now == null ? null : { sentenceId: row, sentence: now.text, sentences: now };
  }
  const word = kind === 'or' || kind === 'wa' ? row : indexOf(doc).wordOf.get(row)?.id;
  if (!word) return null;
  const now = wordNow(doc, word, row);
  return now && { wordId: word, rowId: row, ...now };
};

/**
 * What the cell is on now, as `{ unit, text, ids, reshaped }` (`ids` the
 * re-cut row, which names who re-cut it), when the word under `shape` was
 * split, joined or respelled since (its text changed), or its morpheme
 * re-segmented or respelled (its form changed), or its sentence split, joined
 * or respelled, else null. `reshaped` is true for a split, join or merge
 * (domain/cells/recut.js), after which Enter keeps nothing.
 */
export const recutOf = (doc, shape) => {
  if (!shape) return null;
  if (shape.sentenceId) {
    const now = sentenceNow(doc, shape.sentenceId);
    return now != null && now.text !== shape.sentence
      ? {
          unit: 'sentence',
          text: now.text,
          ids: [shape.sentenceId],
          reshaped: reshaped({ ...shape.sentences, text: shape.sentence }, now),
        }
      : null;
  }
  const now = wordNow(doc, shape.wordId, shape.rowId);
  if (!now) return null;
  if (now.word !== shape.word) {
    return {
      unit: 'word',
      text: now.word,
      ids: [shape.wordId],
      reshaped: reshaped({ text: shape.word, ...shape.words }, { text: now.word, ...now.words }),
    };
  }
  if (shape.morpheme != null && now.morpheme != null && now.morpheme !== shape.morpheme) {
    return {
      unit: 'morpheme',
      text: now.morpheme,
      ids: [shape.rowId],
      reshaped: reshaped(
        { text: shape.morpheme, ...shape.morphemes },
        { text: now.morpheme, ...now.morphemes },
      ),
    };
  }
  return null;
};
