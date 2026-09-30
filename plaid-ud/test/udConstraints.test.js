// The layer rules UD declares, on open, at setup and with a settings save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  queueDeclarations,
  queueRuleChanges,
  rulesNotInForce,
  wantedConstraints,
  withConfigWrites,
} from '../src/utils/udConstraints.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

console.error = () => {};

const INPUT = [
  '# text = she came',
  '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t_\t_',
  '2\tcame\tcome\tVERB\t_\t_\t0\troot\t_\t_',
].join('\n');

const byLayer = (wanted) => Object.fromEntries(wanted.map((w) => [w.layerId, w.constraints]));

test('UD wants its rules on the layers it owns, a value set only on a closed list', () => {
  const info = getUdLayerInfo(rawDocFromConllu(INPUT, 'e', { enhanced: true }));
  const rules = byLayer(wantedConstraints(info));
  const sentences = info.sentenceTokenLayer.id;
  assert.deepEqual(rules[info.morphemeTokenLayer.id], [{ type: 'coextensive' }]);
  for (const l of [info.formLayer, info.lemmaLayer, info.uposLayer, info.xposLayer]) {
    assert.deepEqual(rules[l.id], [{ type: 'single-span' }]);
  }
  assert.equal(rules[info.featuresLayer.id], undefined);
  assert.deepEqual(rules[info.relationLayer.id], [
    { type: 'acyclic', selfLoops: true },
    { type: 'max-in-degree', max: 1 },
    { type: 'same-ancestor', tokenLayer: sentences },
  ]);
  assert.deepEqual(rules[info.enhancedRelationLayer.id], [
    { type: 'same-ancestor', tokenLayer: sentences },
  ]);

  const closed = {
    ...info,
    modes: { upos: 'closed', xpos: 'open', deprel: 'closed' },
    vocab: { ...info.vocab, upos: ['NOUN', 'VERB'], deprel: ['nsubj', 'root'] },
  };
  const closedRules = byLayer(wantedConstraints(closed));
  assert.deepEqual(closedRules[info.uposLayer.id][1], {
    type: 'value-set',
    values: ['NOUN', 'VERB'],
    delimiters: '',
    parts: 'all',
  });
  assert.deepEqual(closedRules[info.relationLayer.id].at(-1), {
    type: 'value-set',
    values: ['nsubj', 'root'],
    delimiters: ':',
    parts: 'first',
  });
  assert.deepEqual(wantedConstraints(null), []);
});

test('a settings save queues the layers whose rules it changes, and leaves an undeclared one to the next open', () => {
  const raw = rawDocFromConllu(INPUT, 'e');
  const info = getUdLayerInfo(raw);
  info.uposLayer.constraints = { ud: [{ type: 'single-span' }] };
  const writes = [
    { entity: info.uposLayer, key: 'vocabMode', value: 'closed' },
    { entity: info.relationLayer, key: 'vocabMode', value: 'closed' },
  ];
  const after = getUdLayerInfo(withConfigWrites(raw, writes));
  after.uposLayer.constraints = info.uposLayer.constraints;
  const queued = [];
  const b = {
    spanLayers: { setConstraints: (...a) => queued.push(['span', ...a]) },
    relationLayers: { setConstraints: (...a) => queued.push(['relation', ...a]) },
  };
  assert.equal(queueRuleChanges(b, info, after), 1);
  assert.equal(queued[0][1], info.uposLayer.id);
  assert.equal(queued[0][3][1].type, 'value-set');
  assert.deepEqual(queued[0][5], { expected: [{ type: 'single-span' }] });
});

test('queueDeclarations declares what differs, naming what each layer holds', () => {
  const queued = [];
  const b = { tokenLayers: { setConstraints: (...a) => queued.push(a) } };
  queueDeclarations(b, [
    {
      kind: 'token',
      layerId: 't',
      namespace: 'ud',
      constraints: [{ type: 'coextensive' }],
      stored: null,
    },
    {
      kind: 'token',
      layerId: 'u',
      namespace: 'ud',
      constraints: [{ type: 'coextensive' }],
      stored: [{ type: 'coextensive' }],
    },
  ]);
  assert.deepEqual(queued, [['t', 'ud', [{ type: 'coextensive' }], undefined, { expected: null }]]);
  // A list held with its keys in another order is the same list.
  queued.length = 0;
  queueDeclarations(b, [
    {
      kind: 'token',
      layerId: 'v',
      namespace: 'ud',
      constraints: [{ type: 'acyclic', selfLoops: true }],
      stored: [{ selfLoops: true, type: 'acyclic' }],
    },
  ]);
  assert.deepEqual(queued, []);
});

test('a layer the data breaks becomes one warning', () => {
  const info = { relationLayer: { id: 'r', name: 'Dependency Relations' } };
  const [f] = rulesNotInForce(
    [
      {
        layerId: 'r',
        kind: 'relation',
        namespace: 'ud',
        constraints: ['max-in-degree'],
        violationCount: 2,
      },
    ],
    info,
  );
  assert.equal(f.code, 'layer-rules-not-in-force');
  assert.equal(f.severity, 'warning');
  assert.match(f.message, /"Dependency Relations"/);
});

test("a maintainer's open repairs, then declares UD's rules, and a reader's declares nothing", async () => {
  const run = async (user, maintainers) => {
    const calls = [];
    const bundle = (name) => ({
      setConfig: async () => {},
      setConstraints: async (...a) => calls.push([`${name}.setConstraints`, ...a]),
      repairConstraints: async (...a) => {
        calls.push([`${name}.repairConstraints`, ...a]);
        return { repaired: [] };
      },
    });
    const client = withOps({
      tokenLayers: bundle('tokenLayers'),
      spanLayers: bundle('spanLayers'),
      relationLayers: bundle('relationLayers'),
      relations: { delete: async () => {} },
      tokens: { bulkCreate: async () => {} },
    });
    const doc = new ConlluDocument({
      raw: rawDocFromConllu(INPUT, 'e', { enhanced: true }),
      client,
      project: { maintainers },
      user: { id: user },
    });
    const result = await doc._reconcile();
    return { calls, result };
  };
  const reader = await run('r@x.org', ['m@x.org']);
  assert.deepEqual(reader.calls, []);
  const { calls, result } = await run('m@x.org', ['m@x.org']);
  const kinds = calls.map((c) => c[0]);
  assert.ok(kinds.indexOf('relationLayers.repairConstraints') >= 0);
  assert.ok(
    kinds.indexOf('relationLayers.setConstraints') >
      kinds.lastIndexOf('spanLayers.repairConstraints'),
  );
  assert.equal(result.rulesDeclared, true);
  assert.equal(result.error, undefined);
});
