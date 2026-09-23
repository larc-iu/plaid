import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_LEXICON,
  argsOfEntry,
  buildLexicon,
  entriesStartingWith,
  entryLabel,
  linkedEntries,
  vocabLinksByToken,
} from '../src/domain/vocabLexicon.js';

// A vocabulary as vocabLayers.get(id, true) returns it: a headword with a
// sense, a roleset entry, and one with nothing but a form.
const vocab = {
  id: 'v1',
  name: 'Lexicon',
  items: [
    { id: 'i1', form: 'leave', metadata: { gloss: 'go away' } },
    { id: 'i2', form: 'leave', metadata: { parent: 'i1', gloss: 'depart', senseOrder: 1 } },
    {
      id: 'i3',
      form: 'lunch',
      metadata: { gloss: 'midday meal', umr: { roleset: 'lunch-01', args: { ARG0: 'eater' } } },
    },
    { id: 'i4', form: 'Lindsay', metadata: {} },
    { id: 'i5', form: 'orphan', metadata: { parent: 'gone' } },
  ],
};

test('an entry offers its headword, or the roleset it names', () => {
  const lex = buildLexicon([vocab]);
  assert.deepEqual(
    lex.entries.map((e) => e.form),
    ['leave', 'leave', 'Lindsay', 'lunch', 'orphan'],
  );
  assert.equal(lex.byId.get('i1').concept, 'leave');
  // A sense offers its headword too.
  assert.equal(lex.byId.get('i2').concept, 'leave');
  assert.equal(lex.byId.get('i2').sense, true);
  assert.equal(lex.byId.get('i3').concept, 'lunch-01');
  assert.deepEqual(lex.byId.get('i3').args, { ARG0: 'eater' });
  // A parent that is not in the vocabulary makes the item its own headword.
  assert.equal(lex.byId.get('i5').concept, 'orphan');
  assert.equal(lex.byId.get('i5').sense, false);
});

test('labels carry the gloss and the arguments', () => {
  const lex = buildLexicon([vocab]);
  assert.equal(entryLabel(lex.byId.get('i1')), 'leave  go away');
  assert.equal(entryLabel(lex.byId.get('i3')), 'lunch-01  midday meal  ARG0 eater');
  assert.equal(entryLabel(lex.byId.get('i4')), 'Lindsay');
});

test('links by token read the word and morpheme layers, and resolve to entries once each', () => {
  const layerInfo = {
    wordTokenLayer: {
      vocabs: [{ id: 'v1', vocabLinks: [{ id: 'l1', vocabItem: { id: 'i1' }, tokens: ['w2'] }] }],
    },
    morphemeTokenLayer: {
      vocabs: [
        {
          id: 'v1',
          vocabLinks: [
            { id: 'l2', vocabItem: { id: 'i1' }, tokens: ['m2'] },
            { id: 'l3', vocabItem: { id: 'i3' }, tokens: ['m7', 'm8'] },
            { id: 'l4', vocabItem: { id: 'nope' }, tokens: ['m9'] },
          ],
        },
      ],
    },
  };
  const links = vocabLinksByToken(layerInfo);
  assert.deepEqual(links.get('w2'), ['i1']);
  assert.deepEqual(links.get('m8'), ['i3']);
  const lex = buildLexicon([vocab]);
  assert.deepEqual(
    linkedEntries(lex, links, ['w2', 'm2', 'm7']).map((e) => e.id),
    ['i1', 'i3'],
  );
  // An entry the lexicon does not have, and a token with no link, offer nothing.
  assert.deepEqual(linkedEntries(lex, links, ['m9', 'w1']), []);
});

test('typing finds entries by form or by the roleset they name', () => {
  const lex = buildLexicon([vocab]);
  assert.deepEqual(
    entriesStartingWith(lex, 'le').map((e) => e.id),
    ['i1', 'i2'],
  );
  assert.deepEqual(
    entriesStartingWith(lex, 'lunch-0').map((e) => e.id),
    ['i3'],
  );
  assert.deepEqual(entriesStartingWith(lex, ''), []);
  assert.equal(entriesStartingWith(lex, 'l', 2).length, 2);
});

// A language being documented has no bundled frame file, so the role picker
// asks the vocabulary for a concept's arguments (see pickers.js).
test('a roleset kept in the vocabulary names its arguments, in number order', () => {
  const lex = buildLexicon([
    {
      id: 'v2',
      name: 'Lexicon',
      items: [
        {
          id: 'j1',
          form: 'give',
          metadata: {
            umr: { roleset: 'give-01', args: { ARG2: 'recipient', ARG0: 'giver', note: 'ignore' } },
          },
        },
        { id: 'j2', form: 'dog', metadata: { gloss: 'dog' } },
      ],
    },
  ]);
  assert.deepEqual(argsOfEntry(lex, 'give-01'), [
    { role: ':ARG0', description: 'giver' },
    { role: ':ARG2', description: 'recipient' },
  ]);
  // An entry with no roleset stands for its headword and describes nothing.
  assert.deepEqual(argsOfEntry(lex, 'dog'), []);
  assert.deepEqual(argsOfEntry(lex, 'leave-02'), []);
  assert.deepEqual(argsOfEntry(lex, null), []);
  assert.deepEqual(argsOfEntry(EMPTY_LEXICON, 'give-01'), []);
});

// Two senses of one headword, each describing its own arguments and naming no
// roleset, so both offer the headword as their concept.
const tapa = {
  id: 'v2',
  name: 'Lex',
  items: [
    { id: 'h1', form: 'tapa', metadata: {} },
    {
      id: 's1',
      form: 'tapa',
      metadata: {
        parent: 'h1',
        gloss: 'cut',
        umr: { args: { ARG0: 'cutter', ARG1: 'thing cut' } },
      },
    },
    {
      id: 's2',
      form: 'tapa',
      metadata: {
        parent: 'h1',
        gloss: 'call',
        umr: { args: { ARG0: 'caller', ARG2: 'name given' } },
      },
    },
  ],
};

test('the arguments are those of the entry the node was made from', () => {
  const lex = buildLexicon([tapa]);
  const roles = (entryId) => argsOfEntry(lex, 'tapa', entryId).map((a) => a.description);
  assert.deepEqual(roles('s2'), ['caller', 'name given']);
  assert.deepEqual(roles('s1'), ['cutter', 'thing cut']);
  // The headword describes no arguments of its own, and borrows none.
  assert.deepEqual(roles('h1'), []);
});

test('without the entry, two senses that disagree offer neither', () => {
  const lex = buildLexicon([tapa]);
  assert.deepEqual(argsOfEntry(lex, 'tapa'), []);
  // An entry that no longer stands for the node's concept says nothing.
  assert.deepEqual(argsOfEntry(buildLexicon([vocab]), 'tapa', 'i3'), []);
  // One entry, or several that agree, is still enough.
  assert.deepEqual(
    argsOfEntry(buildLexicon([vocab]), 'lunch-01').map((a) => a.role),
    [':ARG0'],
  );
});
