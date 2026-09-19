import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, readToken } from './fixtures.js';
import { getFixture } from './fixtureProject.js';
import { importUmrDocument } from '../src/domain/umrImport.js';
import { getUmrLayerInfo } from '../src/utils/umrLayerUtils.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';

// A .umr file imported onto a document that already has the words (the way
// an IGT document does): the graphs land on those words, and a document that
// already holds nodes, or whose words differ, is refused. API only.
const FILE = `################################################################################
# :: snt1	Dogs bark .
Index: 1 2 3
Words: Dogs bark .

# sentence level graph:
(s1b / bark-01
    :ARG0 (s1d / dog)
    :aspect habitual)

# alignment:
s1b: 2-2
s1d: 1-1

# document level annotation:
(s1s0 / sentence
    :modal ((root :modal author)
        (author :full-affirmative s1b)))


`;

const API = 'http://localhost:8085';

test('a file lands on the words of a document that has them', async () => {
  const { projectId } = await getFixture();
  const client = new PlaidClient(API, readToken().token);
  const project = await client.projects.get(projectId);
  const layerInfo = getUmrLayerInfo(project);
  const name = `attach ${Date.now()}`;

  // The words first, as another app would have made them, with no graph.
  const first = await importUmrDocument(
    client,
    projectId,
    name,
    FILE.replace(
      /# sentence level graph:[\s\S]*?# alignment:/,
      '# sentence level graph:\n\n# alignment:',
    ),
    layerInfo,
  );
  try {
    let doc = await UmrDocument.load({ client, documentId: first.document.id, projectId });
    expect(doc.sentences[0].nodes.length).toBe(0);
    expect(doc.sentences[0].words.map((w) => w.text)).toEqual(['Dogs', 'bark', '.']);

    // Now the graphs, onto it.
    const second = await importUmrDocument(client, projectId, name, FILE, layerInfo, {
      into: first.document.id,
    });
    expect(second.attached).toBe(true);
    expect(second.document.id).toBe(first.document.id);
    doc = await UmrDocument.load({ client, documentId: first.document.id, projectId });
    const s1 = doc.sentences[0];
    expect(s1.nodes.map((n) => n.concept).sort()).toEqual(['bark-01', 'dog']);
    expect(s1.roots[0].concept).toBe('bark-01');
    const bark = s1.nodes.find((n) => n.concept === 'bark-01');
    expect(bark.wordIds).toEqual([s1.words[1].id]);
    expect(doc.toUmr()).toContain(':ARG0 (s1d / dog)');
    expect(doc.toUmr()).toContain('(author :full-affirmative s1b)');

    // Twice is refused: it holds nodes now.
    await expect(
      importUmrDocument(client, projectId, name, FILE, layerInfo, { into: first.document.id }),
    ).rejects.toThrow(/already holds/);

    // Different words are refused before anything is written.
    const other = await importUmrDocument(
      client,
      projectId,
      `${name} b`,
      FILE.replace('Dogs bark .', 'Cats purr .')
        .replace('Words: Dogs bark .', 'Words: Cats purr .')
        .replace(
          /# sentence level graph:[\s\S]*?# alignment:/,
          '# sentence level graph:\n\n# alignment:',
        ),
      layerInfo,
    );
    try {
      await expect(
        importUmrDocument(client, projectId, name, FILE, layerInfo, { into: other.document.id }),
      ).rejects.toThrow(/differs/);
    } finally {
      await client.documents.delete(other.document.id);
    }
  } finally {
    await client.documents.delete(first.document.id);
  }
});
