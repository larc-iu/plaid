// Every Analyze-tab edit shows before the server answers, creates included.
// The client here holds every write until the test lets it through, so what
// the document shows in between is what an annotator sees while the round
// trip is in flight.
import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';
import { isPendingId } from '@ui/domain/pendingIds.js';

const GROUPS = ['tokens', 'spans', 'vocabLinks', 'vocabItems'];

// A fake client whose writes, direct or batched, wait on `release()`.
// `fail` names one call (`spans.create`) whose next use is refused.
const heldClient = ({ fail = null, reloadDoc } = {}) => {
  const client = makeFakeClient({ reloadDoc });
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  for (const group of GROUPS) {
    for (const [method, fn] of Object.entries(client[group])) {
      client[group][method] = async (...args) => {
        await gate;
        if (fail === `${group}.${method}`) {
          fail = null;
          throw new Error('refused');
        }
        return fn(...args);
      };
    }
  }
  const batched = client.batched.bind(client);
  client.batched = async (fn) => {
    await gate;
    return batched(fn);
  };
  return { client, release: () => open() };
};

const vocabularies = () => ({
  v1: {
    id: 'v1',
    name: 'Lexicon',
    items: [{ id: 'vi-1', form: 'CAT', metadata: {} }],
    vocabLinks: [],
  },
});

const makeDoc = ({ raw = buildRawDoc(), ...options } = {}) => {
  const { client, release } = heldClient({ ...options, reloadDoc: structuredClone(raw) });
  const doc = new IgtDocument({
    raw: structuredClone(raw),
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
    vocabularies: vocabularies(),
    client,
    projectId: 'proj-1',
  });
  return { doc, client, release };
};

const word = (doc, i) => doc.sentences[0].tokens[i];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => resetIds());

describe('an Analyze edit shows before the server answers', () => {
  it('a gloss on a word nobody has segmented, and the morpheme it makes', async () => {
    const { doc, release } = makeDoc({ raw: buildRawDoc({ morphemes: [] }) });
    const write = doc.updateMorphemeSpan(word(doc, 0).morphemes[0].id, 'Gloss', 'DEF');
    await settle();
    const m = word(doc, 0).morphemes[0];
    expect(m.virtual).toBeUndefined();
    expect(isPendingId(m.id)).toBe(true);
    expect(m.annotations.Gloss?.value).toBe('DEF');

    release();
    expect(await write).toBe(true);
    const saved = word(doc, 0).morphemes[0];
    expect(isPendingId(saved.id)).toBe(false);
    expect(isPendingId(saved.annotations.Gloss.id)).toBe(false);
  });

  it('a split, and a merge of the piece it made', async () => {
    const { doc, release } = makeDoc();
    const split = doc.splitMorpheme('m-1', 'th', 'e');
    await settle();
    expect(word(doc, 0).morphemes.map((m) => m.metadata.form)).toEqual(['th', 'e']);
    const second = word(doc, 0).morphemes[1];
    expect(isPendingId(second.id)).toBe(true);

    // Merged back before the server has answered for the split at all.
    const merged = doc.mergeMorphemes(second.id);
    await settle();
    expect(word(doc, 0).morphemes.map((m) => m.metadata.form)).toEqual(['the']);

    release();
    expect(await split).toBe(true);
    expect(await merged).toBe(true);
    expect(word(doc, 0).morphemes).toHaveLength(1);
  });

  it('a link to an entry, and one made with a new entry', async () => {
    const { doc, release } = makeDoc();
    const linked = doc.linkVocab('w-2', 'vi-1');
    await settle();
    expect(word(doc, 1).vocabItem?.form).toBe('CAT');

    const created = doc.createAndLinkVocabItem('w-1', 'v1', 'THE');
    await settle();
    expect(word(doc, 0).vocabItem?.form).toBe('THE');
    expect(doc.vocabularies.v1.items.some((i) => i.form === 'THE')).toBe(true);

    release();
    expect(await linked).toBe(true);
    expect(await created).toBe(true);
    const links = doc.vocabularies.v1.vocabLinks;
    expect(links.every((l) => !isPendingId(l.id))).toBe(true);
    expect(doc.vocabularies.v1.items.every((i) => !isPendingId(i.id))).toBe(true);
  });

  it('a whole-word confirm that adopts a guess, without a reload', async () => {
    const { doc, client, release } = makeDoc({ raw: buildRawDoc({ morphemes: [] }) });
    const target = word(doc, 0).morphemes[0].id;
    const write = doc.confirmWordAnalysis('w-1', [
      { targetId: target, field: 'Gloss', value: 'DEF', metadata: null },
    ]);
    await settle();
    expect(word(doc, 0).morphemes[0].annotations.Gloss?.value).toBe('DEF');

    release();
    expect(await write).toBe(true);
    expect(client.calls.some((c) => c.kind === 'documents.get')).toBe(false);
    expect(isPendingId(word(doc, 0).morphemes[0].annotations.Gloss.id)).toBe(false);
  });

  it('an edit of a morpheme still being made is sent under its server id', async () => {
    const { doc, client, release } = makeDoc();
    doc.splitMorpheme('m-1', 'th', 'e');
    await settle();
    const pending = word(doc, 0).morphemes[1].id;
    const glossed = doc.updateMorphemeSpan(pending, 'Gloss', 'DEF');
    await settle();
    expect(word(doc, 0).morphemes[1].annotations.Gloss?.value).toBe('DEF');

    release();
    expect(await glossed).toBe(true);
    const span = client.calls.find((c) => c.kind === 'spans.create');
    expect(span.args[1]).toEqual([word(doc, 0).morphemes[1].id]);
    expect(isPendingId(span.args[1][0])).toBe(false);
  });

  it('a refused write reloads, and the edits queued behind it are not sent', async () => {
    const { doc, client, release } = makeDoc({ fail: 'spans.create' });
    const first = doc.updateMorphemeSpan('m-1', 'Gloss', 'DEF');
    const second = doc.updateTokenSpan('w-1', 'POS', 'DET');
    await settle();
    expect(word(doc, 0).annotations.POS?.value).toBe('DET');

    release();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(client.calls.filter((c) => c.kind === 'spans.create')).toHaveLength(0);
    expect(word(doc, 0).annotations.POS ?? null).toBeNull();
    expect(doc.isSaving).toBe(false);
  });
});
