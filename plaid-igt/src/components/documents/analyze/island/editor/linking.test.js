import { describe, expect, it, vi } from 'vitest';
import { linking } from './linking.js';

// A stand-in editor: one morpheme whose gloss records the senses its producer
// weighed, and a document that records the writes.
function editor({ search = '', glossMeta = {} } = {}) {
  const morph = {
    id: 'm1',
    vocabItem: null,
    annotations: {
      Gloss: {
        value: 'sell',
        metadata: {
          prov: 'inferred',
          provSource: 'service:x',
          provDetail: {
            valueLinks: [
              { value: 'sell', item: 'i-sell', prob: 0.4 },
              { value: 'another', item: 'i-another', prob: 0.3 },
            ],
          },
          ...glossMeta,
        },
      },
    },
  };
  const doc = {
    sentences: [{ tokens: [{ morphemes: [morph] }] }],
    vocabularies: { v: { items: [{ id: 'i-sell' }, { id: 'i-another' }] } },
    linkVocab: vi.fn(() => true),
    unlinkVocab: vi.fn(() => true),
    updateMorphemeSpan: vi.fn(() => true),
    adoptStamp: vi.fn((source, detail) => ({ adopted: source, ...detail })),
  };
  return {
    ...linking,
    doc,
    _popoverSearch: search,
    _closePopover() {
      this._popoverSearch = '';
    },
    _runThenFocus: (_target, fn) => fn(),
  };
}

const flush = () => new Promise((r) => setTimeout(r));

describe('linking a sense the model weighed from the lexicon popover', () => {
  it('adopts the suggestion and sets the gloss to match', async () => {
    const ed = editor();
    await ed._toggleVocab('m1', { id: 'i-another' }, false);
    await flush();
    expect(ed.doc.linkVocab).toHaveBeenCalledWith('m1', 'i-another', {
      adopted: 'service:x',
      vocabItem: 'i-another',
    });
    expect(ed.doc.updateMorphemeSpan).toHaveBeenCalledWith('m1', 'Gloss', 'another', null, {
      adopted: true,
    });
  });

  it('is the person’s own link when they found the entry by searching', async () => {
    const ed = editor({ search: 'anoth' });
    await ed._toggleVocab('m1', { id: 'i-another' }, false);
    expect(ed.doc.linkVocab).toHaveBeenCalledWith('m1', 'i-another', null);
  });

  it('leaves a gloss a person confirmed', async () => {
    const ed = editor({ glossMeta: { provConfirmed: true } });
    await ed._toggleVocab('m1', { id: 'i-another' }, false);
    await flush();
    expect(ed.doc.updateMorphemeSpan).not.toHaveBeenCalled();
  });

  it('treats an entry the vocabularies no longer hold as no sense', async () => {
    const ed = editor();
    ed.doc.vocabularies = { v: { items: [{ id: 'i-sell' }] } };
    await ed._toggleVocab('m1', { id: 'i-another' }, false);
    expect(ed.doc.linkVocab).toHaveBeenCalledWith('m1', 'i-another', null);
  });
});
