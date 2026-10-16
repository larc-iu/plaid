import { describe, it, expect } from 'vitest';
import { declareIgtRules, fieldConstraints, fieldsOutOfForce } from './igtConstraints.js';
import { valueSetAllows } from '../../../plaid-client-js/src/constraints.js';
import { sameConstraints } from '../../../plaid-ui/src/lib/layerConstraints.js';

// The invariant FX-D-WIRE fixes by (B/fixes/FX-D-WIRE.md): once
// `declareIgtRules` has run, which every settings save, import, resume and
// "Use the project as it is" ends with, every IGT field's rules on the server
// are what its settings want, unless the server would refuse stored values,
// and then the field is named with those values and keeps the list it held
// (nothing is enforced less than before). Checked over a generated sweep of
// projects against a model of core's rules: the value-set check with its
// exemptions, `expected`, and a batch that lands whole or not at all.

// A small seeded generator, so a failing case can be run again.
const rng = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const POOL = ['PL', 'SG', 'NOM', 'ERG', 'N', 'V', 'dog'];
const VALUES = ['PL', 'NOM.PL', 'ERG', 'QQ', 'N', 'V', 'dog.PL', 'SG.QQ', '', null];

const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const subset = (r, xs) => xs.filter(() => r() < 0.5);
const clone = (x) => JSON.parse(JSON.stringify(x));

const valueSet = (values) => ({ type: 'value-set', values, delimiters: '.', parts: 'all' });

const generate = (seed) => {
  const r = rng(seed);
  const tagsets = {};
  for (const name of ['Leipzig', 'POS', 'Other']) {
    if (r() < 0.8) {
      tagsets[name] = {
        mode: pick(r, ['closed', 'closed', 'suggest', 'mixed']),
        delimiters: '.',
        values: subset(r, POOL).map((value) => ({ value })),
      };
    }
  }
  const project = { id: 'p', config: { igt: { tagsets } } };
  const fields = [];
  const data = new Map();
  for (let i = 0; i < 1 + Math.floor(r() * 4); i++) {
    const id = `sl-${i}`;
    const tagset = r() < 0.85 ? pick(r, ['Leipzig', 'POS', 'Other', 'Gone']) : undefined;
    const config = { igt: { scope: pick(r, ['Word', 'Morpheme']), ...(tagset ? { tagset } : {}) } };
    // What the server holds: what the settings want, nothing, the one-span
    // rule only, or a list the settings no longer name (another tagset's,
    // an old copy of this one), as drift leaves it.
    const kind = pick(r, ['wanted', 'none', 'span', 'old', 'old']);
    const stored =
      kind === 'wanted'
        ? fieldConstraints(config, project.config)
        : kind === 'none'
          ? null
          : kind === 'span'
            ? [{ type: 'single-span' }]
            : [{ type: 'single-span' }, valueSet(subset(r, POOL))];
    // Stored values: an exempt one (an import's, a machine's) may be off any
    // list, a person's obeys the list the layer held when it was written.
    const held = (stored || []).find((c) => c.type === 'value-set');
    const values = [];
    for (let j = 0; j < Math.floor(r() * 5); j++) {
      const value = pick(r, VALUES);
      const exempt = r() < 0.3;
      if (exempt || !held || valueSetAllows(held, value)) values.push({ value, exempt });
    }
    data.set(id, values);
    fields.push({ id, name: `F${i}`, config, constraints: stored ? { igt: stored } : {} });
  }
  // Half the fields under the word layer, the rest under the morpheme layer.
  project.textLayers = [
    {
      id: 'tl',
      name: 'Text',
      config: { plaid: { role: 'baseline' } },
      tokenLayers: [
        {
          id: 'w',
          name: 'Words',
          config: { plaid: { role: 'word' } },
          constraints: { igt: [{ type: 'single-link' }] },
          spanLayers: fields.filter((f) => f.config.igt.scope === 'Word'),
        },
        {
          id: 'm',
          name: 'Morphemes',
          config: { plaid: { role: 'morpheme' } },
          constraints: { igt: [{ type: 'coextensive' }, { type: 'single-link' }] },
          spanLayers: fields.filter((f) => f.config.igt.scope === 'Morpheme'),
        },
      ],
    },
  ];
  return { project, data, fields };
};

// Core as far as these calls go.
const fakeCore = ({ project, data }) => {
  const layer = (id) =>
    project.textLayers[0].tokenLayers.flatMap((t) => t.spanLayers).find((s) => s.id === id);
  const refused = (id, rules) =>
    (data.get(id) || []).filter(
      (v) => !v.exempt && rules.some((c) => c.type === 'value-set' && !valueSetAllows(c, v.value)),
    );
  const violation = (vs) =>
    Object.assign(new Error('HTTP 422'), {
      status: 422,
      responseData: {
        violations: vs.map((v) => ({ constraint: 'value-set', value: v.value })),
        'violation-count': vs.length,
      },
    });
  const setConstraints = (id, ns, list, _doc, options) => {
    const sl = layer(id);
    const stored = sl.constraints?.[ns] ?? null;
    if (options && Object.hasOwn(options, 'expected')) {
      if (!sameConstraints(options.expected ?? null, stored)) {
        throw Object.assign(new Error('HTTP 409'), { status: 409 });
      }
    }
    const vs = refused(id, list);
    if (vs.length) throw violation(vs);
    sl.constraints = { ...sl.constraints, [ns]: list };
  };
  const spanLayers = {
    setConstraints: async (...a) => setConstraints(...a),
    checkConstraints: async (id, rules) => {
      const vs = refused(id, rules);
      return {
        violations: vs.map((v) => ({ constraint: 'value-set', value: v.value })),
        violationCount: vs.length,
      };
    },
    refusedValues: async (id, rule) => {
      const vs = refused(id, [rule]);
      const by = new Map();
      for (const v of vs) by.set(v.value, (by.get(v.value) ?? 0) + 1);
      return {
        count: vs.length,
        valueCount: by.size,
        values: [...by].map(([value, count]) => ({ value, parts: [value], count })),
      };
    },
    repairConstraints: async () => ({ repaired: [] }),
    get: async (id) => clone(layer(id)),
  };
  const client = {
    projects: { get: async () => clone(project) },
    spanLayers,
    tokenLayers: { setConstraints: async () => {}, checkConstraints: async () => ({}) },
    withOperation: async (_m, fn) => fn(),
    // Lands whole or not at all.
    async batched(fn) {
      const saved = clone(project.textLayers);
      const ops = [];
      const queue = (bundle) =>
        new Proxy(
          {},
          {
            get:
              (_, m) =>
              (...a) =>
                ops.push(() => client[bundle][m](...a)),
          },
        );
      fn({ spanLayers: queue('spanLayers'), tokenLayers: queue('tokenLayers') });
      try {
        for (const op of ops) await op();
      } catch (e) {
        project.textLayers = saved;
        throw e;
      }
      return ops.map(() => ({ status: 200, body: {} }));
    },
  };
  return { client, layer, refused };
};

const CASES = 3000;

describe('declareIgtRules over a generated sweep', () => {
  it('leaves every field as its settings want, or named with the values in the way', async () => {
    const violations = [];
    let healed = 0;
    let named = 0;
    for (let seed = 1; seed <= CASES; seed++) {
      const g = generate(seed);
      const before = new Map(g.fields.map((f) => [f.id, clone(f.constraints?.igt ?? null)]));
      const core = fakeCore(g);
      const fail = (what) => violations.push(`seed ${seed}: ${what}`);
      let out;
      try {
        out = await declareIgtRules(core.client, 'p', { fieldsOnly: true });
      } catch (e) {
        fail(`threw ${e.message}`);
        continue;
      }
      const names = new Set(out.notInForce.map((n) => n.layerId));
      for (const f of g.fields) {
        const wanted = fieldConstraints(f.config, g.project.config);
        const stored = core.layer(f.id).constraints?.igt ?? null;
        const rule = wanted.find((c) => c.type === 'value-set');
        const inWay = rule ? core.refused(f.id, [rule]) : [];
        if (sameConstraints(stored, wanted)) {
          if (names.has(f.id)) fail(`${f.id} in force and named`);
          if (!sameConstraints(before.get(f.id), wanted)) healed += 1;
          continue;
        }
        // Out of force: only for values in the way, named with them, and
        // holding what it held before (with the rules nothing breaks).
        if (!inWay.length) fail(`${f.id} out of force with nothing in the way`);
        const entry = out.notInForce.find((n) => n.layerId === f.id);
        if (!entry) fail(`${f.id} out of force and not named`);
        else if (entry.count !== inWay.length)
          fail(`${f.id} named ${entry.count} of ${inWay.length}`);
        const heldBefore = (before.get(f.id) || []).filter((c) => c.type === 'value-set');
        const heldNow = (stored || []).filter((c) => c.type === 'value-set');
        if (!sameConstraints(heldBefore, heldNow)) fail(`${f.id} list held changed while refused`);
        if (!(stored || []).some((c) => c.type === 'single-span')) fail(`${f.id} lost single-span`);
        named += 1;
      }
      // What the settings screen shows agrees with the server afterwards,
      // and a second run writes nothing and names the same fields.
      const after = fieldsOutOfForce(await core.client.projects.get());
      if (after.length !== out.notInForce.length) {
        fail(`fieldsOutOfForce ${after.length} against ${out.notInForce.length} named`);
      }
      const snapshot = JSON.stringify(g.project.textLayers);
      const again = await declareIgtRules(core.client, 'p', { fieldsOnly: true });
      if (JSON.stringify(g.project.textLayers) !== snapshot) fail('a second run wrote');
      if (again.notInForce.length !== out.notInForce.length) fail('a second run named others');
    }
    expect(violations).toEqual([]);
    // The sweep reaches both outcomes often.
    expect(healed).toBeGreaterThan(CASES / 4);
    expect(named).toBeGreaterThan(CASES / 10);
  });
});
