import { describe, it, expect } from 'vitest';
import { refusedMetadataBySave } from './refusedMetadata.js';

// What a save would newly take into a closed list over a document metadata
// field (H2-12-3, REV-G2-1). A value the list already refused before the save
// (it got in before the check, or by a stale page) holds up no save: adding a
// value, editing a description or renaming goes through, as core does for an
// annotation field.

// Two documents hold Coastal, five Inland.
const client = {
  query: async () => ({
    results: [
      ['Coastal', 2],
      ['Inland', 5],
    ],
  }),
};
const cfg = (values, { mode = 'closed', tagset = 'Dialects' } = {}) => ({
  igt: {
    tagsets: {
      Dialects: { delimiters: '', mode, values: values.map((value) => ({ value })) },
    },
    documentMetadata: [{ name: 'Dialect', ...(tagset ? { tagset } : {}) }],
  },
});

describe('refusedMetadataBySave', () => {
  it('lets a closed list already broken take a value', async () => {
    expect(
      await refusedMetadataBySave(client, 'p', cfg(['Inland', 'Mountain']), cfg(['Inland'])),
    ).toEqual([]);
  });

  it('lets a closed list take the value it refused', async () => {
    expect(
      await refusedMetadataBySave(client, 'p', cfg(['Inland', 'Coastal']), cfg(['Inland'])),
    ).toEqual([]);
  });

  it('refuses a value the save takes off the list', async () => {
    const r = await refusedMetadataBySave(
      client,
      'p',
      cfg(['Coastal']),
      cfg(['Inland', 'Coastal']),
    );
    expect(r).toEqual([
      {
        layerId: 'meta:Dialect',
        field: 'Dialect',
        noun: 'document',
        count: 5,
        valueCount: 1,
        values: [{ value: 'Inland', count: 5, parts: ['Inland'] }],
      },
    ]);
  });

  it('refuses closing an open list over a value not in it', async () => {
    const r = await refusedMetadataBySave(
      client,
      'p',
      cfg(['Inland']),
      cfg(['Inland'], { mode: 'suggest' }),
    );
    expect(r.map((f) => f.values.map((v) => v.value))).toEqual([['Coastal']]);
  });

  it('refuses pointing the field at a closed list it breaks', async () => {
    const r = await refusedMetadataBySave(
      client,
      'p',
      cfg(['Inland']),
      cfg(['Inland'], { tagset: null }),
    );
    expect(r.map((f) => f.count)).toEqual([2]);
  });
});
