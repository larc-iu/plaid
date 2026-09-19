// The Restore dialog's list in this app's words: a node counted once, as a
// node, and not again by the token that anchors it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRole } from '@larc-iu/plaid-client';
import { changeLines, indexLayers } from '../../plaid-ui/src/domain/restoreSummary.js';
import { TOKEN_ROLE_WORDS, UMR_LAYER_WORDS } from '../src/domain/restoreSummary.js';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { rawFromPlan } from './rawFromPlan.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'umr');

test('the restore list names nodes, edges and document-level relations', () => {
  const file = fs.readdirSync(FIXTURES).find((f) => f.endsWith('.umr'));
  const text = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
  const raw = rawFromPlan(planImport(parseUmrFile(text).sentences, []));
  const layers = indexLayers(raw, readRole, UMR_LAYER_WORDS);
  const [text0] = raw.textLayers;
  const [sentences, words, nodes] = text0.tokenLayers;
  const [concepts] = nodes.spanLayers;
  const [edges, docGraph] = concepts.relationLayers;
  const summary = {
    tokens: {
      byLayer: [
        { layerId: sentences.id, updated: 1 },
        { layerId: words.id, inserted: 2 },
        { layerId: nodes.id, inserted: 2 },
      ],
    },
    spans: { byLayer: [{ layerId: concepts.id, inserted: 2 }] },
    relations: {
      byLayer: [
        { layerId: edges.id, inserted: 3 },
        { layerId: docGraph.id, deleted: 1 },
      ],
    },
  };
  assert.deepEqual(changeLines(summary, layers, TOKEN_ROLE_WORDS), [
    '1 sentence',
    '2 words',
    '2 nodes',
    '3 edges',
    '1 document-level relation',
  ]);
});
