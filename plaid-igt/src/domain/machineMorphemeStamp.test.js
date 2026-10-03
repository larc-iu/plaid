import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';

// The morpheme a write makes for an unanalyzed word carries that write's
// stamp. Auto-analyze's link and copy steps are machine writes, so the
// morphemes they make are machine-made, never the requester's own work
// (REV-FX3-AGENT-1). A person's own link still makes a morpheme that is theirs.

const ANN = { id: 'ann@x.com', isAdmin: false };

beforeEach(() => resetIds());

const docAs = (user, client) =>
  new IgtDocument({
    raw: buildRawDoc({ morphemes: [] }),
    project: {
      id: 'proj-1',
      vocabs: [],
      config: { plaid: { review: { users: [ANN.id] } }, igt: {} },
      maintainers: [],
      writers: [ANN.id],
    },
    vocabularies: { v1: { id: 'v1', items: [{ id: 'i-1', form: 'the' }], vocabLinks: [] } },
    client,
    projectId: 'proj-1',
    user,
  });

// The metadata of every morpheme the client was asked to make.
const madeMorphemes = (client) =>
  client.calls.flatMap((c) => {
    if (c.kind === 'tokens.create' && c.args[0] === 'morphL') return [c.args[5] ?? {}];
    if (c.kind === 'tokens.bulkCreate')
      return c.args[0].filter((t) => t.tokenLayerId === 'morphL').map((t) => t.metadata ?? {});
    return [];
  });

describe('a morpheme made for a machine write', () => {
  it('auto-link makes it machine-made, for a contributor', async () => {
    const client = makeFakeClient();
    const doc = docAs(ANN, client);
    expect(doc.contributorId).toBe(ANN.id);
    await doc.bulkLinkVocab(
      [
        { tokenId: 'virtual:w-1', vocabItemId: 'i-1' },
        { tokenId: 'virtual:w-2', vocabItemId: 'i-1' },
      ],
      'rule:test',
    );
    const made = madeMorphemes(client);
    expect(made).toHaveLength(2);
    for (const m of made) {
      expect(m.prov).toBe('inferred');
      expect(m.provSource).toBe('rule:test');
    }
  });

  it('the analysis copy makes it machine-made, for a contributor', async () => {
    const client = makeFakeClient();
    const doc = docAs(ANN, client);
    const n = await doc.bulkApplyAnalyses(
      [
        {
          wordTokenId: 'w-1',
          analysis: { morphemes: [{ form: 'the', fields: { Gloss: 'DEF' } }] },
        },
      ],
      'rule:analysis-precedent',
    );
    expect(n).toBe(1);
    const made = madeMorphemes(client);
    expect(made).toHaveLength(1);
    expect(made[0].prov).toBe('inferred');
    expect(made[0].provSource).toBe('rule:analysis-precedent');
  });

  it("a contributor's own link still makes a morpheme that is theirs", async () => {
    const client = makeFakeClient();
    const doc = docAs(ANN, client);
    await doc.linkVocab('virtual:w-1', 'i-1');
    const made = madeMorphemes(client);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ prov: 'contributed', provSource: 'user:ann@x.com' });
  });
});
