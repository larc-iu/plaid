import { describe, it, expect } from 'vitest';
import { writerPolicy } from '@larc-iu/plaid-client';
import { IgtDocument } from '../../../domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient } from '../../../domain/test-helpers.js';
import { buildReplacer, collectFieldRows, collectRespellRows } from './bulkPlan.js';
import { applyField, applyRespell } from './bulkRunner.js';

// A field replace is a person's edit of every value it changes, so each value
// carries the writer's stamp in the same entry, as a typed edit does: a
// verifier's confirms machine work, a contributor's marks it contributed, and
// the producer's provProb, the probability of the value replaced, goes.

const MACHINE = { prov: 'inferred', provSource: 'service:m', provProb: 0.6 };

const strictMode = () => ({
  documentVersions: {},
  enterStrictMode() {},
  exitStrictMode() {},
});

const docWithMachineWork = () => {
  const raw = buildRawDoc({ body: 'the cats' });
  raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
    { id: 'sp-1', tokens: ['w-1'], value: 'DOG', metadata: { ...MACHINE } },
  ];
  raw.textLayers[0].tokenLayers[2].tokens[1].metadata = { form: 'DOG', ...MACHINE };
  return new IgtDocument({ raw, client: makeFakeClient() });
};
const wordTarget = { kind: 'span', scope: 'word', field: 'POS', layerId: 'wsl-0' };

const run = async (target, writer) => {
  const doc = docWithMachineWork();
  const rows = collectFieldRows(doc, target, buildReplacer('DOG', 'exact', 'dog').apply);
  const client = Object.assign(makeFakeClient(), strictMode());
  await applyField(client, { rows, versions: { [doc.id]: 1 } }, { writer, label: 'Replace' });
  return client;
};
const sent = (client, kind) =>
  client.calls.filter((c) => c.kind === kind).flatMap((c) => c.args[0]);

describe('Bulk Edit replace stamps through the writer', () => {
  it("a verifier's replace of a machine value confirms it and drops provProb", async () => {
    const client = await run(wordTarget, writerPolicy(null));
    expect(sent(client, 'spans.bulkUpdate')).toEqual([
      {
        id: 'sp-1',
        value: 'dog',
        metadata: [
          { op: 'set', path: ['provConfirmed'], value: true },
          { op: 'delete', path: ['provProb'] },
        ],
      },
    ]);
  });

  it("a contributor's replace marks the value contributed", async () => {
    const client = await run(wordTarget, writerPolicy('ann@x.com'));
    const [entry] = sent(client, 'spans.bulkUpdate');
    expect(entry.metadata).toEqual([
      { op: 'set', path: ['prov'], value: 'contributed' },
      { op: 'set', path: ['provSource'], value: 'user:ann@x.com' },
      { op: 'delete', path: ['provConfirmed'] },
      { op: 'delete', path: ['provProb'] },
    ]);
  });

  it('a morpheme form replace carries the stamp beside the form', async () => {
    const client = await run({ kind: 'morpheme' }, writerPolicy(null));
    expect(sent(client, 'tokens.bulkUpdate')).toEqual([
      {
        id: 'm-2',
        metadata: [
          { op: 'set', path: ['form'], value: 'dog' },
          { op: 'set', path: ['provConfirmed'], value: true },
          { op: 'delete', path: ['provProb'] },
        ],
      },
    ]);
  });

  it("a person's own value is replaced with no stamp", async () => {
    const doc = docWithMachineWork();
    doc._raw.textLayers[0].tokenLayers[1].spanLayers[0].spans[0].metadata = {};
    const rows = collectFieldRows(doc, wordTarget, buildReplacer('DOG', 'exact', 'dog').apply);
    const client = Object.assign(makeFakeClient(), strictMode());
    await applyField(
      client,
      { rows, versions: { [doc.id]: 1 } },
      { writer: writerPolicy(null), label: 'Replace' },
    );
    expect(sent(client, 'spans.bulkUpdate')).toEqual([{ id: 'sp-1', value: 'dog' }]);
  });
});

// REV-PROV-1: a respelled morpheme form is the same value change as a field
// replace of it, so it carries the same stamp.
describe('Bulk Edit Respell stamps the morpheme forms it respells', () => {
  const respell = async (writer) => {
    const raw = buildRawDoc({ body: 'the cat' });
    raw.textLayers[0].tokenLayers[2].tokens[1].metadata = { form: 'cat', ...MACHINE };
    const doc = new IgtDocument({ raw, client: makeFakeClient() });
    const rows = collectRespellRows(doc, buildReplacer('cat', 'exact', 'dog').apply);
    const client = Object.assign(makeFakeClient(), strictMode());
    await applyRespell(
      client,
      { rows, lexiconRows: [], versions: { [doc.id]: 1 } },
      { writer, includeMorphemes: true, label: 'Respell' },
    );
    return client;
  };

  it("a verifier's respell confirms a machine form and drops provProb", async () => {
    const client = await respell(writerPolicy(null));
    expect(sent(client, 'tokens.bulkUpdate')).toEqual([
      {
        id: 'm-2',
        metadata: [
          { op: 'set', path: ['form'], value: 'dog' },
          { op: 'set', path: ['provConfirmed'], value: true },
          { op: 'delete', path: ['provProb'] },
        ],
      },
    ]);
  });

  it("a contributor's respell marks the form contributed", async () => {
    const client = await respell(writerPolicy('ann@x.com'));
    const [entry] = sent(client, 'tokens.bulkUpdate');
    expect(entry.metadata).toEqual([
      { op: 'set', path: ['form'], value: 'dog' },
      { op: 'set', path: ['prov'], value: 'contributed' },
      { op: 'set', path: ['provSource'], value: 'user:ann@x.com' },
      { op: 'delete', path: ['provConfirmed'] },
      { op: 'delete', path: ['provProb'] },
    ]);
  });
});
