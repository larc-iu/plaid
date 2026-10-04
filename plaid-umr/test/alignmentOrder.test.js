// The `# alignment:` block lists a sentence's nodes in the order the graph
// above it writes them, as the released files do, whatever their anchors.
// It followed where each anchor began, and a node made unaligned on the
// canvas stands over its old word while an imported unaligned node stands
// over the whole sentence, so an export imported and exported again listed
// the same lines in another order (H34-UMR polish).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { toUmrSentences } from '../src/domain/sentenceGraph.js';
import { rawFromPlan } from './rawFromPlan.js';
import { twoWriterCore } from './twoWriterCore.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'umr');
const NAMES = fs.readdirSync(FIXTURES).filter((n) => n.endsWith('.umr'));
const load = (text) => rawFromPlan(planImport(parseUmrFile(text).sentences, []));
const exported = (raw) => new UmrDocument({ raw: structuredClone(raw) }).toUmr();

// Per sentence: the variables in the order its graph defines them, and in
// the order its alignment block lists them.
function blocks(text) {
  return text
    .split(/^#{80}$/m)
    .slice(1)
    .map((chunk) => {
      const graph = chunk.split('# sentence level graph:')[1]?.split('# alignment:')[0] ?? '';
      const align = chunk.split('# alignment:')[1]?.split('# document level annotation:')[0] ?? '';
      return {
        defined: [...graph.matchAll(/\(\s*(s[0-9]+[^\s/()]*)\s*\//g)].map((m) => m[1]),
        listed: align
          .split('\n')
          .filter((l) => l.includes(':'))
          .map((l) => l.split(':')[0].trim()),
      };
    });
}

for (const name of NAMES) {
  test(`${name}: the alignment block follows the graph's order`, () => {
    const raw = load(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
    // A graph kept as text (one the parser could not read) is written back
    // as it came, alignment block included.
    const kept = toUmrSentences(new UmrDocument({ raw: structuredClone(raw) }).graph).map(
      (s) => typeof s.rawGraph === 'string',
    );
    let checked = 0;
    blocks(exported(raw)).forEach(({ defined, listed }, i) => {
      if (kept[i]) return;
      checked += 1;
      assert.deepEqual(listed, defined, `sentence ${i + 1}`);
    });
    assert.ok(checked > 0);
  });
}

test('an export imported and exported again lists its alignment lines in the same order', async () => {
  const raw = load(fs.readFileSync(path.join(FIXTURES, 'english_umr-0001.umr'), 'utf8'));
  const core = twoWriterCore(raw);
  const page = await core.open('a');
  // Made unaligned on the canvas: each stands over the word it had.
  for (const v of ['s1l', 's1c', 's1m']) {
    const node = page.doc.sentence(1).nodes.find((n) => n.var === v);
    assert.ok(await page.doc.setAnchor(node.id, []), v);
  }
  page.release();
  const first = exported(core.raw);
  const second = exported(load(first));
  assert.equal(second, first);
  assert.match(first, /\n# alignment:\ns1p: 1-1\ns1l: 0-0\ns1a: 0-0\ns1d: 2-2\n/);
});
