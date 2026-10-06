// The layer rules UD declares at setup and with a settings save, and never on an open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  queueDeclarations,
  queueRuleChanges,
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

// R2-DEBT-APPS-10: as IGT's settings do, a layer that holds no rules yet is
// declared too, so a list the stored data breaks is refused with the save.
test('a settings save queues the layers whose rules it changes, each naming what it holds', () => {
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
  const repaired = [];
  const b = {
    spanLayers: {
      setConstraints: (...a) => queued.push(['span', ...a]),
      repairConstraints: (...a) => repaired.push(['span', ...a]),
    },
    relationLayers: {
      setConstraints: (...a) => queued.push(['relation', ...a]),
      repairConstraints: (...a) => repaired.push(['relation', ...a]),
    },
  };
  assert.equal(queueRuleChanges(b, info, after), 2);
  // The layer with no rules yet is repaired first (ruling on FX-UI's
  // question): a doubled head is not repairable, but crossing relations are.
  assert.deepEqual(
    repaired.map((r) => r[1]),
    [info.relationLayer.id],
  );
  const upos = queued.find((q) => q[1] === info.uposLayer.id);
  assert.equal(upos[3][1].type, 'value-set');
  assert.deepEqual(upos[5], { expected: [{ type: 'single-span' }] });
  const deps = queued.find((q) => q[1] === info.relationLayer.id);
  assert.ok(deps[3].some((c) => c.type === 'value-set'));
  assert.deepEqual(deps[5], { expected: null });
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

// R3-UD: the rules are declared at setup, adopt and a settings save, and a
// one-off script declared them on the projects made before. An open of a
// project whose layers hold none, whose word layer lacks splitOnSpace and
// whose enhanced layer holds a suppressor over no relation writes none of it,
// for a maintainer, a writer or a reader.
test('an open declares no rule, repairs nothing, sets no key and deletes no suppressor', async () => {
  const run = async (user, maintainers, writers = []) => {
    const calls = [];
    const record =
      (name) =>
      async (...a) => {
        calls.push([name, ...a]);
        return name.endsWith('checkConstraints') ? { violations: [], violationCount: 0 } : {};
      };
    const bundle = (name) => ({
      setConfig: record(`${name}.setConfig`),
      setConstraints: record(`${name}.setConstraints`),
      checkConstraints: record(`${name}.checkConstraints`),
      repairConstraints: record(`${name}.repairConstraints`),
    });
    const client = withOps({
      tokenLayers: bundle('tokenLayers'),
      spanLayers: bundle('spanLayers'),
      relationLayers: bundle('relationLayers'),
      relations: { delete: record('relations.delete') },
      tokens: { bulkCreate: record('tokens.bulkCreate') },
    });
    const doc = new ConlluDocument({
      raw: rawDocFromConllu(INPUT, 'e', { enhanced: true }),
      client,
      project: { maintainers, writers },
      user: { id: user },
    });
    const info = doc.layerInfo;
    assert.equal(info.wordTokenLayer.config?.plaid?.splitOnSpace, undefined);
    assert.equal(info.relationLayer.constraints, undefined);
    // A suppressor over the pair the tree's nsubj joins the other way round:
    // it lies over no relation.
    const nsubj = info.relationLayer.relations.find((r) => r.source !== r.target);
    info.enhancedRelationLayer.relations = [
      {
        id: 'x1',
        source: nsubj.target,
        target: nsubj.source,
        value: null,
        metadata: { suppress: true },
      },
    ];
    const result = await doc._reconcile();
    assert.equal(result.error, undefined);
    return calls;
  };
  assert.deepEqual(await run('r@x.org', ['m@x.org']), []);
  assert.deepEqual(await run('w@x.org', ['m@x.org'], ['w@x.org']), []);
  assert.deepEqual(await run('m@x.org', ['m@x.org']), []);
});
