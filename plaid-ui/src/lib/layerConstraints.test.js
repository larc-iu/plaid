import { describe, it, expect } from 'vitest';
import { ensureLayerConstraints, storedConstraints } from './layerConstraints.js';
import { humanizeError, isChangedElsewhere, isConstraintViolation } from './errors.js';

// A client with the four bundle methods, a batch that queues them, and a
// scripted answer per (method, layer).
const fakeClient = (answers = {}) => {
  const calls = [];
  const groups = [];
  const run = (method, layerId, args) => {
    calls.push([method, layerId, ...args]);
    const a = answers[`${method}:${layerId}`];
    if (a instanceof Error) throw a;
    return a ?? (method === 'repairConstraints' ? { repaired: [] } : { constraints: {} });
  };
  const bundle = () => ({
    setConstraints: (id, ...args) => run('setConstraints', id, args),
    repairConstraints: (id, ...args) => run('repairConstraints', id, args),
    get: (id) => run('get', id, []),
  });
  const client = {
    calls,
    groups,
    tokenLayers: bundle(),
    spanLayers: bundle(),
    relationLayers: bundle(),
    withOperation: async (label, fn, opts) => {
      groups.push([label, opts]);
      return fn(() => {});
    },
    batched: async (fn) => {
      const queued = [];
      const b = {};
      for (const k of ['tokenLayers', 'spanLayers', 'relationLayers']) {
        b[k] = {
          setConstraints: (...args) => queued.push(['setConstraints', ...args]),
          repairConstraints: (...args) => queued.push(['repairConstraints', ...args]),
        };
      }
      fn(b);
      calls.push(['batch', queued.length]);
      const out = [];
      for (const [method, id, ...args] of queued) out.push(run(method, id, args));
      return out;
    },
  };
  return client;
};

const refused = (violations) => {
  const e = new Error('HTTP 422');
  e.status = 422;
  e.responseData = {
    error: 'A span is the target of 2 relations in "Deps".',
    violations,
    'violation-count': violations.length,
  };
  return e;
};

const entry = (layerId, constraints, stored = null, kind = 'span') => ({
  kind,
  layerId,
  namespace: 'igt',
  constraints,
  stored,
});

describe('comparing lists', () => {
  it('reads absent, null and empty alike and ignores key order, but not value order', async () => {
    const c = fakeClient();
    await ensureLayerConstraints(
      c,
      [
        entry('A', [], null),
        entry('B', [{ type: 'value-set', values: ['a'] }], [{ values: ['a'], type: 'value-set' }]),
      ],
      { canManage: true },
    );
    expect(c.calls).toEqual([]);
    await ensureLayerConstraints(
      c,
      [
        entry(
          'C',
          [{ type: 'value-set', values: ['a', 'b'] }],
          [{ type: 'value-set', values: ['b', 'a'] }],
        ),
      ],
      { canManage: true },
    );
    expect(c.calls.some((x) => x[0] === 'setConstraints' && x[1] === 'C')).toBe(true);
    expect(storedConstraints({ constraints: { igt: [{ type: 'single-span' }] } }, 'igt')).toEqual([
      { type: 'single-span' },
    ]);
    expect(storedConstraints({}, 'igt')).toBe(null);
  });
});

describe('ensureLayerConstraints', () => {
  it('writes nothing for a reader, or when every list is as stored', async () => {
    const c = fakeClient();
    expect(await ensureLayerConstraints(c, [entry('L', [{ type: 'single-span' }])])).toEqual({
      changed: false,
      repaired: false,
      pending: [],
    });
    const same = [entry('L', [{ type: 'single-span' }], [{ type: 'single-span' }])];
    await ensureLayerConstraints(c, same, { canManage: true });
    expect(c.calls).toEqual([]);
  });

  it('repairs before it declares, in one operation of kind repair', async () => {
    const c = fakeClient({ 'repairConstraints:L': { repaired: [{ document: 'd', deleted: 1 }] } });
    const out = await ensureLayerConstraints(
      c,
      [
        entry('L', [{ type: 'single-span' }]),
        entry('R', [{ type: 'max-in-degree', max: 1 }], null, 'relation'),
      ],
      { canManage: true },
    );
    expect(out).toEqual({ changed: true, repaired: true, pending: [] });
    expect(c.groups).toEqual([['Set up layer rules', { kind: 'repair' }]]);
    expect(c.calls.map((x) => x[0])).toEqual([
      'batch',
      'repairConstraints',
      'batch',
      'setConstraints',
      'setConstraints',
    ]);
    // Only the list with a remediable type is repaired, and the declaration
    // names what it read.
    expect(c.calls[1][1]).toBe('L');
    expect(c.calls[3]).toEqual([
      'setConstraints',
      'L',
      'igt',
      [{ type: 'single-span' }],
      undefined,
      { expected: null },
    ]);
  });

  it('leaves a layer the data breaks undeclared, under pending, and declares the rest', async () => {
    const c = fakeClient({
      'setConstraints:R': refused([
        { constraint: 'max-in-degree' },
        { constraint: 'max-in-degree' },
      ]),
    });
    const out = await ensureLayerConstraints(
      c,
      [
        entry('L', [{ type: 'single-span' }]),
        entry('R', [{ type: 'max-in-degree', max: 1 }], null, 'relation'),
      ],
      { canManage: true },
    );
    expect(out.changed).toBe(true);
    expect(out.pending).toEqual([
      {
        layerId: 'R',
        kind: 'relation',
        namespace: 'igt',
        constraints: ['max-in-degree'],
        violationCount: 2,
      },
    ]);
  });

  it('reads a layer another maintainer declared meanwhile once, and stops', async () => {
    const conflict = Object.assign(new Error('HTTP 409'), { status: 409, responseData: {} });
    const c = fakeClient({
      'setConstraints:L': conflict,
      'get:L': { constraints: { igt: [{ type: 'single-span' }] } },
    });
    const out = await ensureLayerConstraints(c, [entry('L', [{ type: 'single-span' }])], {
      canManage: true,
    });
    expect(out.pending).toEqual([]);
    expect(c.calls.filter((x) => x[0] === 'get')).toHaveLength(1);
  });
});

describe('a refusal by a layer rule', () => {
  it('is its own kind of error, not a conflict, and reads as the server words it', () => {
    const e = refused([{ constraint: 'max-in-degree' }]);
    expect(isConstraintViolation(e)).toBe(true);
    expect(isChangedElsewhere(e)).toBe(false);
    expect(humanizeError(e)).toBe('A span is the target of 2 relations in "Deps".');
    const reused = Object.assign(new Error('HTTP 422'), {
      status: 422,
      responseData: { error: 'idempotency-key-reused' },
    });
    expect(isConstraintViolation(reused)).toBe(false);
  });
});
