import { describe, it, expect } from 'vitest';
import { buildContextRows, contextLayers, runHitsSearch } from './searchRunner.js';
import { buildRawDoc } from '@/domain/test-helpers.js';
import { getIgtLayerInfo } from '@/domain/layerInfo.js';
import { failsInCell } from '../validate/locateFailing.js';
import { GLOSS_DOMAIN, MIXED, hitsClient } from '../validate/cellReadingFixture.js';

// runHitsSearch with and without `keep`: the Search tab lists every
// occurrence of a value, the Validation tab only the ones that fail.

const project = { id: 'p-1', vocabs: [] };
const fails = failsInCell({ tagset: MIXED, domain: GLOSS_DOMAIN });
const search = (client, opts) =>
  runHitsSearch(client, project, null, GLOSS_DOMAIN, 'sbj:3.pfv', 'exact', opts);

describe('runHitsSearch', () => {
  it('lists every occurrence of the value with no filter', async () => {
    const res = await search(hitsClient());
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0].docHits).toBe(3);
    expect(res.groups[0].rows.map((r) => r.text)).toEqual(['kati', 'sa', 'harbu']);
    expect(res.remainingHits).toBe(0);
  });

  it('with a filter, lists the occurrences the grid flags, counting only those', async () => {
    // The suffix's and the stem's beside another stem fail. The stem alone in
    // its word reads as lexical and passes.
    const res = await search(hitsClient(), { keep: fails });
    expect(res.groups[0].rows.map((r) => r.text)).toEqual(['kati', 'harbu']);
    expect(res.groups[0].docHits).toBe(2);
  });

  it('with a filter, drops a document left with nothing to list', async () => {
    const res = await search(hitsClient(), { keep: () => false });
    expect(res.groups).toEqual([]);
  });

  it('with a filter, keeps a capped document even when none of the hits it got fail', async () => {
    // More hits in one document than a query returns: the ones past the cap
    // may fail, so the document stays and says it stops short.
    const client = hitsClient();
    const ids = client.query;
    client.query = async (q) => ({ ...(await ids(q)), ...(q?.return ? {} : { truncated: true }) });
    const res = await search(client, { keep: () => false });
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0].capped).toBe(true);
    expect(res.groups[0].rows).toEqual([]);
  });

  it('with a filter, does not claim a number of hits in the documents it did not load', async () => {
    const ids = Array.from({ length: 13 }, (_, i) => `doc-${i + 1}`);
    const plain = await search(hitsClient(ids));
    expect(plain.remainingDocs).toBe(1);
    expect(plain.remainingHits).toBe(3);
    const kept = await search(hitsClient(ids), { keep: fails });
    expect(kept.remainingDocs).toBe(1);
    expect(kept.remainingHits).toBeNull();
    expect(kept.groups.every((g) => g.docHits === 2)).toBe(true);
  });
});

// SCL2-2: a common term's hits are in the biggest documents, and each was
// read whole, every field of it, for a few context lines.
describe('contextLayers', () => {
  const tree = buildRawDoc({ wordFields: ['POS', 'Gloss'], morphFields: ['Gloss'] });
  const info = getIgtLayerInfo(tree);
  const domain = (kind, extra = {}) => ({ kind, ...extra });
  const base = ['tl-1', 'sentL', 'wordL', 'alignL'];
  const sentenceFields = info.spanLayers.sentence.map((sl) => sl.id);

  it('reads the words and the sentence fields for a word search, not the morphemes', () => {
    expect(contextLayers(tree, info, domain('token')).sort()).toEqual(
      [...base, ...sentenceFields].sort(),
    );
  });

  it('reads the morphemes for a morpheme or lexicon search', () => {
    for (const kind of ['morpheme', 'lexicon']) {
      expect(contextLayers(tree, info, domain(kind)).sort()).toEqual(
        [...base, 'morphL', ...sentenceFields].sort(),
      );
    }
  });

  it('reads the field searched and no other', () => {
    const field = info.spanLayers.morpheme[0].id;
    const got = contextLayers(tree, info, domain('span', { scope: 'morpheme', layerId: field }));
    expect(got.sort()).toEqual([...base, 'morphL', ...sentenceFields, field].sort());
    const word = info.spanLayers.word[1].id;
    expect(contextLayers(tree, info, domain('span', { scope: 'word', layerId: word }))).toContain(
      word,
    );
    expect(
      contextLayers(tree, info, domain('span', { scope: 'word', layerId: word })),
    ).not.toContain(info.spanLayers.word[0].id);
  });

  it('reads every field when a filter may look at any', () => {
    const all = contextLayers(tree, info, domain('token'), () => true);
    for (const sl of [...info.spanLayers.word, ...info.spanLayers.morpheme]) {
      expect(all).toContain(sl.id);
    }
  });

  it('is what runHitsSearch asks each document for', async () => {
    const client = hitsClient();
    const get = client.documents.get;
    const asked = [];
    client.documents.get = (id, body, asOf, layers) => {
      asked.push(layers);
      return get(id, body, asOf, layers);
    };
    const field = info.spanLayers.morpheme[0].id;
    const gloss = { ...GLOSS_DOMAIN, layerId: field };
    await runHitsSearch(client, tree, info, gloss, 'sbj:3.pfv', 'exact');
    expect(asked.length).toBeGreaterThan(0);
    for (const layers of asked) {
      expect(layers.sort()).toEqual(contextLayers(tree, info, gloss).sort());
    }
  });
});

describe('buildContextRows', () => {
  const layer = (name, sentenceRole) => ({
    id: `sl-${name}`,
    name,
    config: { igt: { scope: 'Sentence', ...(sentenceRole ? { sentenceRole } : {}) } },
  });
  const doc = (layers, annotations) => ({
    body: 'perros',
    layerInfo: { spanLayers: { word: [], morpheme: [], sentence: layers } },
    sentences: [
      {
        id: 's-1',
        begin: 0,
        end: 6,
        annotations: { Note: { id: 'n-1', value: 'recorded twice' }, ...annotations },
        tokens: [],
      },
    ],
  });
  const domain = { kind: 'span', scope: 'sentence', field: 'Note' };
  const rowOf = (d) => buildContextRows(d, domain, new Set(['n-1']))[0];

  it('takes the translation from the field whose role is translation', () => {
    const layers = [layer('Note', 'note'), layer('Lit'), layer('Free', 'translation')];
    expect(rowOf(doc(layers, { Free: { id: 'f-1', value: 'dogs' } })).translation).toBe('dogs');
  });

  it('gives none when that field is empty, or no field holds the role', () => {
    const lit = { Lit: { id: 'l-1', value: 'dogs they' } };
    expect(
      rowOf(doc([layer('Note', 'note'), layer('Lit'), layer('Free', 'translation')], lit)),
    ).toMatchObject({ translation: '' });
    expect(rowOf(doc([layer('Note', 'note'), layer('Lit')], lit))).toMatchObject({
      translation: '',
    });
  });

  // H2-8-1, REV-G4-R2-1: a value in a note line reads in its own direction
  // beside the field's name. The note is parts (a string drawn as it is,
  // { isolate } in a <bdi>), so its text holds no isolate character.
  it('gives a hit’s note line in parts, the value to isolate', () => {
    const layers = [layer('Note', 'note')];
    const row = buildContextRows(
      doc(layers, { Note: { id: 'n-1', value: 'ذهب Ahmed إلى' } }),
      domain,
      new Set(['n-1']),
    )[0];
    expect(row.notes).toEqual([['Note: ', { isolate: ['ذهب Ahmed إلى'] }]]);
    expect(JSON.stringify(row.notes)).not.toMatch(/[\u2066-\u2069]/);
  });

  it('takes the first translation field the sentence fills', () => {
    const layers = [layer('En', 'translation'), layer('Es', 'translation')];
    expect(rowOf(doc(layers, { Es: { id: 'e-1', value: 'perros' } })).translation).toBe('perros');
  });
});
