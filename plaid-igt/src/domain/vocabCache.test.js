import { describe, it, expect } from 'vitest';
import { readVocabulary } from './vocabCache.js';
import { loadProjectVocabularies } from './IgtDocument.js';

// A server holding one vocabulary whose time moves on every change, the way
// core stamps `modified_at` on every entry write.
const server = () => {
  const state = { time: 't1', items: [{ id: 'a', form: 'uno' }] };
  const reads = [];
  const client = {
    vocabLayers: {
      get: async (id, withItems, asOf) => {
        reads.push(withItems ? (asOf ? ['items', asOf] : ['items']) : ['time']);
        const head = { id, name: 'Lexicon', timeModified: state.time };
        if (!withItems) return head;
        const out = { ...head, items: structuredClone(state.items) };
        // A change landing while the entries are on their way.
        state.afterRead?.();
        state.afterRead = null;
        return out;
      },
    },
  };
  const change = (items, time) => {
    state.items = items;
    state.time = time;
  };
  return { client, reads, state, change };
};

describe('readVocabulary', () => {
  it('reuses the entries while the vocabulary has not changed, and reads them again once it has', async () => {
    const { client, reads, change } = server();
    const first = await readVocabulary(client, 'v1');
    const second = await readVocabulary(client, 'v1');
    expect(reads).toEqual([['time'], ['items'], ['time']]);
    expect(second.items).toBe(first.items);
    // Each reader gets its own vocabulary object to fold its links into.
    expect(second).not.toBe(first);

    change(
      [
        { id: 'a', form: 'uno' },
        { id: 'b', form: 'dos' },
      ],
      't2',
    );
    const third = await readVocabulary(client, 'v1');
    expect(reads.slice(3)).toEqual([['time'], ['items']]);
    expect(third.items.map((it) => it.form)).toEqual(['uno', 'dos']);
  });

  it('files the entries under the time read before them, so a change during the read is read again', async () => {
    const { client, reads, state, change } = server();
    state.afterRead = () => change([{ id: 'a', form: 'UNO' }], 't2');
    const first = await readVocabulary(client, 'v1');
    expect(first.items[0].form).toBe('uno');
    const second = await readVocabulary(client, 'v1');
    expect(reads).toEqual([['time'], ['items'], ['time'], ['items']]);
    expect(second.items[0].form).toBe('UNO');
  });

  it('keeps nothing for a vocabulary with no time', async () => {
    const { client, reads, change } = server();
    change([{ id: 'a', form: 'uno' }], null);
    await readVocabulary(client, 'v1');
    await readVocabulary(client, 'v1');
    expect(reads).toEqual([['time'], ['items'], ['time'], ['items']]);
  });

  it('reads a past time afresh, and keeps it out of the copy', async () => {
    const { client, reads } = server();
    await readVocabulary(client, 'v1', '2026-01-01T00:00:00Z');
    await readVocabulary(client, 'v1');
    expect(reads).toEqual([['items', '2026-01-01T00:00:00Z'], ['time'], ['items']]);
  });

  it('hands out an entry list no reader can change under another', async () => {
    const { client } = server();
    const { items } = await readVocabulary(client, 'v1');
    expect(Object.isFrozen(items)).toBe(true);
    expect(() => items.push({ id: 'x' })).toThrow();
  });

  it('keeps one copy per client, so a second login never reads the first one', async () => {
    const one = server();
    const two = server();
    await readVocabulary(one.client, 'v1');
    await readVocabulary(two.client, 'v1');
    expect(two.reads).toEqual([['time'], ['items']]);
  });
});

describe('loadProjectVocabularies', () => {
  it('opens a second document of the project without reading the entries again', async () => {
    const { client, reads } = server();
    const project = { id: 'p', vocabs: [{ id: 'v1' }] };
    const a = await loadProjectVocabularies(client, project);
    const b = await loadProjectVocabularies(client, project);
    expect(reads.filter(([k]) => k === 'items')).toHaveLength(1);
    expect(b.vocabularies.v1.items).toBe(a.vocabularies.v1.items);
    expect(b.vocabularies.v1).not.toBe(a.vocabularies.v1);
  });
});
