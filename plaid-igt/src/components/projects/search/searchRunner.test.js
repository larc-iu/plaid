import { describe, it, expect } from 'vitest';
import { runHitsSearch } from './searchRunner.js';
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
