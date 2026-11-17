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
import { queueVocabCells } from '../src/domain/udVocabSave.js';
import { UNIVERSAL_DEPRELS, UPOS_TAGS } from '../src/utils/udVocab.js';
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
    const result = await doc.validateOnOpen();
    assert.equal(result.error, undefined);
    return calls;
  };
  assert.deepEqual(await run('r@x.org', ['m@x.org']), []);
  assert.deepEqual(await run('w@x.org', ['m@x.org'], ['w@x.org']), []);
  assert.deepEqual(await run('m@x.org', ['m@x.org']), []);
});

// REV-TR-1: a closed list is stored. A list read from the shipped default
// moves when the default does (`ref` joined the relations), and core's rule,
// declared from the old default, would then refuse a value the page and the
// assistant offer. So every save that leaves a list closed stores it, as the
// person saw it, and an open list with nothing stored keeps following the
// default.
const recorder = () => {
  const calls = [];
  const bundle = (name) => ({
    setConfig: (id, ns, key, value, _i, opts) =>
      calls.push({ op: 'config', name, id, key, value, opts }),
    setConstraints: (id, ns, constraints, _i, opts) =>
      calls.push({ op: 'rule', name, id, constraints, opts }),
    repairConstraints: () => {},
  });
  return {
    calls,
    b: {
      spanLayers: bundle('spanLayers'),
      relationLayers: bundle('relationLayers'),
      tokenLayers: bundle('tokenLayers'),
    },
  };
};

test('a save that closes a list with nothing stored stores the list shown, and the rule is that list', () => {
  const raw = rawDocFromConllu(INPUT, 'e');
  const info = getUdLayerInfo(raw);
  const { calls, b } = recorder();
  queueVocabCells(b, raw, [
    { bundle: 'relationLayers', entity: info.relationLayer, key: 'vocabMode', value: 'closed' },
    { bundle: 'spanLayers', entity: info.uposLayer, key: 'vocabMode', value: 'closed' },
    { bundle: 'spanLayers', entity: info.featuresLayer, key: 'vocabMode', value: 'closed' },
  ]);
  const stored = (id, key) => calls.find((c) => c.op === 'config' && c.id === id && c.key === key);
  const deprel = stored(info.relationLayer.id, 'vocab');
  assert.deepEqual(deprel.value, [...UNIVERSAL_DEPRELS]);
  assert.ok(deprel.value.includes('ref'));
  assert.deepEqual(stored(info.uposLayer.id, 'vocab').value, [...UPOS_TAGS]);
  assert.deepEqual(
    stored(info.featuresLayer.id, 'inventory').value,
    info.vocab.featureInventory.list,
  );
  const rule = calls.find((c) => c.op === 'rule' && c.id === info.relationLayer.id);
  assert.deepEqual(rule.constraints.at(-1).values, [...UNIVERSAL_DEPRELS]);
  // An open list with nothing stored stores nothing: it follows the default.
  assert.equal(stored(info.xposLayer.id, 'vocab'), undefined);
});

test('an open list with nothing stored stays unstored on a save', () => {
  const raw = rawDocFromConllu(INPUT, 'e');
  const info = getUdLayerInfo(raw);
  const { calls, b } = recorder();
  queueVocabCells(b, raw, [
    {
      bundle: 'relationLayers',
      entity: info.relationLayer,
      key: 'colors',
      value: { nsubj: '#123456' },
    },
  ]);
  assert.deepEqual(
    calls.map((c) => [c.op, c.key]),
    [['config', 'colors']],
  );
});

test('a list found closed with nothing stored is stored and its rule declared again on the next save', () => {
  const raw = rawDocFromConllu(INPUT, 'e');
  const base = getUdLayerInfo(raw);
  // Closed before lists were stored: the mode alone, and core's rule from the
  // default of the day, which had no `ref`.
  const legacy = withConfigWrites(raw, [
    { entity: base.relationLayer, key: 'vocabMode', value: 'closed' },
  ]);
  const info = getUdLayerInfo(legacy);
  const old = UNIVERSAL_DEPRELS.filter((r) => r !== 'ref');
  const held = [
    { type: 'acyclic', selfLoops: true },
    { type: 'max-in-degree', max: 1 },
    { type: 'same-ancestor', tokenLayer: info.sentenceTokenLayer.id },
    { type: 'value-set', values: old, delimiters: ':', parts: 'first' },
  ];
  info.relationLayer.constraints = { ud: held };
  const { calls, b } = recorder();
  // Any save of the settings, here a colour.
  queueVocabCells(b, legacy, [
    {
      bundle: 'relationLayers',
      entity: info.relationLayer,
      key: 'colors',
      value: { nsubj: '#123456' },
    },
  ]);
  const vocab = calls.find((c) => c.op === 'config' && c.key === 'vocab');
  assert.equal(vocab.id, info.relationLayer.id);
  assert.deepEqual(vocab.value, [...UNIVERSAL_DEPRELS]);
  const rule = calls.find((c) => c.op === 'rule' && c.id === info.relationLayer.id);
  assert.ok(rule, 'the rule is declared again');
  assert.deepEqual(rule.constraints.at(-1).values, [...UNIVERSAL_DEPRELS]);
  assert.deepEqual(rule.opts, { expected: held });

  // Once stored, a save that changes no list re-declares nothing.
  const healed = withConfigWrites(
    legacy,
    [vocab].map((c) => ({ entity: info.relationLayer, key: c.key, value: c.value })),
  );
  const again = recorder();
  queueVocabCells(again.b, healed, [
    {
      bundle: 'relationLayers',
      entity: getUdLayerInfo(healed).relationLayer,
      key: 'colors',
      value: {},
    },
  ]);
  assert.deepEqual(
    again.calls.map((c) => [c.op, c.key]),
    [['config', 'colors']],
  );
});
