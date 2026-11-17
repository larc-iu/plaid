import { describe, it, expect } from 'vitest';
import { buildRawDoc, makeFakeClient, makeIgtDoc, settle } from '@/domain/test-helpers.js';

// REV-HFV-2: spreading one word's analysis ("analyze every X like this", and
// Bulk Edit's Re-analyze) confirms the word it came from. A multi-word
// expression is no part of a word's analysis, so a machine one over that word
// stays unverified: only the word's own review keys accept it.
describe('confirming a word whose analysis is spread', () => {
  it('applyAnalysisToWords confirm leaves a machine MWE over the source word alone', async () => {
    const raw = buildRawDoc({
      body: 'the cat sat down the',
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
        { id: 'w-3', begin: 8, end: 11 },
        { id: 'w-4', begin: 12, end: 16 },
        { id: 'w-5', begin: 17, end: 20 },
      ],
    });
    const client = makeFakeClient();
    client.query = async () => ({ results: [] });
    const doc = makeIgtDoc({
      raw,
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
      vocabularies: {
        v1: {
          id: 'v1',
          name: 'Lexicon',
          items: [{ id: 'i-sit', form: 'sit down', metadata: { morphType: 'phrase' } }],
          vocabLinks: [
            {
              id: 'lk-1',
              tokens: ['w-3', 'w-4'],
              vocabItem: { id: 'i-sit', form: 'sit down', metadata: { morphType: 'phrase' } },
              metadata: { prov: 'inferred', provSource: 'rule' },
            },
          ],
        },
      },
      client,
    });
    client.documents.get = async () => doc.raw;
    expect(doc.sentences[0].mwes[0].prov).not.toBe('verified');
    const analysis = { morphemes: [{ form: 'sat', fields: {} }], fields: {} };
    await doc.applyAnalysisToWords(['w-5'], analysis, { confirm: ['w-3'] });
    await settle(5);
    expect((client.calls || []).map((c) => c.kind)).not.toContain('vocabLinks.patchMetadata');
    expect(doc.sentences[0].mwes[0].prov).not.toBe('verified');
  });
});
