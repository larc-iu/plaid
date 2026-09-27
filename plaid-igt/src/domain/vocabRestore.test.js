import { describe, it, expect } from 'vitest';
import { entryRestoreLines, entryRestoreMessage, latestVocabState } from './vocabRestore.js';

const fields = [
  { name: 'gloss', type: 'text' },
  { name: 'pos', type: 'text' },
  { name: 'seeAlso', type: 'item', many: true },
];

describe('entryRestoreLines', () => {
  it('is empty until the dry run answers', () => {
    expect(entryRestoreLines(null, {}, {}, fields)).toEqual([]);
  });

  it('says a deleted entry comes back, and that its links do not', () => {
    const lines = entryRestoreLines(
      { inserted: true, form: false, metadata: false, total: 1 },
      { id: 'a', form: 'kai' },
      null,
      fields,
    );
    expect(lines).toEqual([
      'The entry comes back as it was.',
      'Its links in documents do not come back.',
    ]);
  });

  it('names the form and each field set back, from now to then', () => {
    const past = { id: 'a', form: 'kai', metadata: { gloss: 'eat', pos: 'V', seeAlso: ['b'] } };
    const live = { id: 'a', form: 'kay', metadata: { gloss: 'consume', pos: 'V' } };
    expect(
      entryRestoreLines(
        { inserted: false, form: true, metadata: true, total: 2 },
        past,
        live,
        fields,
      ),
    ).toEqual(['Form: “kay” → “kai”', 'Gloss: “consume” → “eat”', 'See Also']);
  });

  it('names a value that was empty then or is empty now', () => {
    const past = { id: 'a', form: 'kai', metadata: {} };
    const live = { id: 'a', form: 'kai', metadata: { gloss: 'eat' } };
    expect(
      entryRestoreLines(
        { inserted: false, form: false, metadata: true, total: 1 },
        past,
        live,
        fields,
      ),
    ).toEqual(['Gloss: “eat” → —']);
  });

  it('names a moved sense, and anything no field row holds', () => {
    const past = { id: 'a', form: 'kai', metadata: { parent: 'h', senseOrder: 1, flexEntry: 'x' } };
    const live = { id: 'a', form: 'kai', metadata: { parent: 'h', senseOrder: 2 } };
    expect(
      entryRestoreLines(
        { inserted: false, form: false, metadata: true, total: 1 },
        past,
        live,
        fields,
      ),
    ).toEqual(['Its place among the senses', 'Other values']);
  });

  it('says other values change when the server sees a difference the copy on screen does not', () => {
    const entry = { id: 'a', form: 'kai', metadata: { gloss: 'eat' } };
    expect(
      entryRestoreLines(
        { inserted: false, form: true, metadata: true, total: 2 },
        { ...entry, form: 'kay' },
        entry,
        fields,
      ),
    ).toEqual(['Form: “kai” → “kay”', 'Other values']);
  });
});

describe('entryRestoreMessage', () => {
  it('names the entry as the list writes it, and the time', () => {
    const at = '2026-09-27T12:00:00Z';
    expect(entryRestoreMessage('kai 1', at)).toBe(
      `Restore entry “kai 1” to ${new Date(at).toLocaleString()}`,
    );
  });
});

describe('latestVocabState', () => {
  it('reads one entry, newest first, and returns the time its whole unit ends', async () => {
    const asked = [];
    const client = {
      vocabLayers: {
        auditPage: async (id, opts) => {
          asked.push([id, opts]);
          return { entries: [{ id: 'op9', time: 't1', endTime: 't2' }], nextCursor: 'c' };
        },
      },
    };
    expect(await latestVocabState(client, 'v1')).toEqual({ time: 't2', id: 'op9' });
    expect(asked).toEqual([['v1', { order: 'desc', limit: 1 }]]);
  });

  it("reads one entry's newest change when given the entry", async () => {
    const asked = [];
    const client = {
      vocabLayers: {
        auditPage: async (id, opts) => {
          asked.push([id, opts]);
          return { entries: [{ id: 'op3', time: 't3' }] };
        },
      },
    };
    expect(await latestVocabState(client, 'v1', 'i1')).toEqual({ time: 't3', id: 'op3' });
    expect(asked).toEqual([['v1', { order: 'desc', limit: 1, itemId: 'i1' }]]);
  });

  it('is null for a vocabulary with no history', async () => {
    const client = { vocabLayers: { auditPage: async () => ({ entries: [] }) } };
    expect(await latestVocabState(client, 'v1')).toBeNull();
  });
});
