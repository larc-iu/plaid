import { describe, it, expect } from 'vitest';
import { DocumentModel } from './DocumentModel.js';

// The row writes every model makes the same way: a value with the writer's
// stamp, and stamps merged over rows. Each shows in one patch and sends what
// the three models sent by hand.

const raw = () => ({
  id: 'd1',
  textLayers: [
    {
      id: 'tl',
      text: { id: 'x1', body: 'ab', metadata: {} },
      tokenLayers: [
        {
          id: 'tok',
          tokens: [{ id: 't1', begin: 0, end: 2, metadata: {} }],
          spanLayers: [
            {
              id: 'sl',
              spans: [
                { id: 's1', tokens: ['t1'], value: 'N', metadata: { prov: 'inferred' } },
                { id: 's2', tokens: ['t1'], value: 'x' },
              ],
              relationLayers: [
                { id: 'rl', relations: [{ id: 'r1', source: 's1', target: 's2', value: 'nmod' }] },
              ],
            },
          ],
          tokenLayers: [{ id: 'nested', tokens: [{ id: 'm1', begin: 0, end: 1 }] }],
        },
      ],
    },
  ],
});

// Records every call, on the client and on a batch, in order.
const recordingClient = () => {
  const calls = [];
  const resource = (name, where) =>
    new Proxy(
      {},
      {
        get:
          (_, method) =>
          (...args) =>
            calls.push([where, `${name}.${method}`, ...args]),
      },
    );
  const api = (where) => ({
    texts: resource('texts', where),
    tokens: resource('tokens', where),
    spans: resource('spans', where),
    relations: resource('relations', where),
  });
  return {
    calls,
    withOperation: async (_label, fn) => fn(() => {}),
    batched: async (fn) => {
      calls.push(['client', 'batch']);
      await fn(api('batch'));
      return [];
    },
    ...api('client'),
  };
};

const open = () => {
  const client = recordingClient();
  const doc = new DocumentModel({ raw: raw(), client });
  return { doc, client };
};

const span = (doc, id) =>
  doc.raw.textLayers[0].tokenLayers[0].spanLayers[0].spans.find((s) => s.id === id);

describe('DocumentModel row writes', () => {
  it('finds rows of every kind at any depth, and leaves out what is not there', () => {
    const { doc } = open();
    const rows = doc._rowsById(doc.raw, ['x1', 't1', 's2', 'r1', 'm1', 'gone']);
    expect([...rows.keys()].sort()).toEqual(['m1', 'r1', 's2', 't1', 'x1']);
    expect(doc._rowsById(doc.raw, 's1').get('s1').value).toBe('N');
  });

  it('sends a value alone when there are no ops', async () => {
    const { doc, client } = open();
    await doc._writeValue('span', 's2', 'y', [], 'Failed');
    expect(span(doc, 's2')).toEqual({ id: 's2', tokens: ['t1'], value: 'y' });
    expect(client.calls).toEqual([['client', 'spans.update', 's2', 'y']]);
  });

  it('shows and sends a value with its stamp in one batch', async () => {
    const { doc, client } = open();
    const ops = [{ op: 'set', path: ['provConfirmed'], value: true }];
    await doc._writeValue('relation', 'r1', 'obj', ops, 'Failed');
    const rel = doc.raw.textLayers[0].tokenLayers[0].spanLayers[0].relationLayers[0].relations[0];
    expect(rel.value).toBe('obj');
    expect(rel.metadata).toEqual({ provConfirmed: true });
    expect(client.calls).toEqual([
      ['client', 'batch'],
      ['batch', 'relations.update', 'r1', 'obj'],
      ['batch', 'relations.patchMetadata', 'r1', ops],
    ]);
  });

  it('sends the ops alone when the value is left as it is', async () => {
    const { doc, client } = open();
    const ops = [{ op: 'delete', path: ['prov'] }];
    await doc._writeValue('span', 's1', undefined, ops, 'Failed');
    expect(span(doc, 's1')).toMatchObject({ value: 'N', metadata: {} });
    expect(client.calls).toEqual([
      ['client', 'batch'],
      ['batch', 'spans.patchMetadata', 's1', ops],
    ]);
  });

  it('stamps rows in one patch and one batch, in the order given', async () => {
    const { doc, client } = open();
    const before = doc.dataVersion;
    await doc._stampRows(
      [
        ['span', 's1', { provConfirmed: true }],
        ['relation', 'r1', { provConfirmed: true, prov: null }],
      ],
      'Failed',
      'Accept',
      { kind: 'review' },
    );
    expect(doc.dataVersion).toBe(before + 1);
    expect(span(doc, 's1').metadata).toEqual({ prov: 'inferred', provConfirmed: true });
    expect(client.calls).toEqual([
      ['client', 'batch'],
      ['batch', 'spans.patchMetadata', 's1', [{ op: 'set', path: ['provConfirmed'], value: true }]],
      [
        'batch',
        'relations.patchMetadata',
        'r1',
        [
          { op: 'set', path: ['provConfirmed'], value: true },
          { op: 'delete', path: ['prov'] },
        ],
      ],
    ]);
  });
});
