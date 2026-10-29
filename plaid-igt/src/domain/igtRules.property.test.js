import { describe, it, expect } from 'vitest';
import {
  declareIgtRules,
  fieldConstraints,
  fieldsOutOfForce,
  igtFields,
  queueFieldDeclarations,
  refusedBySave,
} from './igtConstraints.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { queueTagsetsSave, tagsetsSaveFields } from './tagsetsSave.js';
import { valueSetAllows } from '../../../plaid-client-js/src/constraints.js';
import { sameConstraints } from '../../../plaid-ui/src/lib/layerConstraints.js';

// The invariant FX-D-WIRE fixes by (B/fixes/FX-D-WIRE.md): once
// `declareIgtRules` has run, which every settings save and import ends with,
// every IGT field's rules on the server
// are what its settings want, unless the server would refuse stored values,
// and then the field is named with those values and keeps the list it held
// (nothing is enforced less than before). Checked over a generated sweep of
// projects against a model of core's rules: the value-set check with its
// exemptions, one span a token, `expected`, and a batch that lands whole or
// not at all.
//
// FX-E-WIRE adds, by the parent's rulings on REV4-WIRE-1 and -2: the heal
// after a save (`repair: false`) never changes an annotation, a field that
// would need a repair to take its rules is named instead, and a settings save
// is refused only for a field in force before it whose new list the stored
// values break. A field out of force before the save never blocks it.
//
// FX-F-WIRE adds, by the rulings on REV5-WIRE-2: a tagset rename repoints its
// fields in the batch that writes the tagsets, so no field is left naming the
// old name.
//
// FX-G-WIRE, by Luke's ruling on REV6-WIRE-1 and -2 (2026-10-16): a field
// naming a tagset the project does not have wants what a field with no tagset
// wants, so the heal takes its list off, and it is named until then. A field
// whose settings want no list holds none after a heal, healed alone or with
// others (REV6-WIRE-3).

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
    // an old copy of this one), with one span a token or without, as drift
    // leaves it.
    const kind = pick(r, ['wanted', 'none', 'span', 'old', 'old', 'list']);
    const stored =
      kind === 'wanted'
        ? fieldConstraints(config, project.config)
        : kind === 'none'
          ? null
          : kind === 'span'
            ? [{ type: 'single-span' }]
            : kind === 'list'
              ? [valueSet(subset(r, POOL))]
              : [{ type: 'single-span' }, valueSet(subset(r, POOL))];
    // Stored values: an exempt one (an import's, a machine's) may be off any
    // list, a person's obeys the list the layer held when it was written.
    // One span a token, unless the layer does not hold that rule: then a
    // second value on a token now and then, as a script may leave.
    const held = (stored || []).find((c) => c.type === 'value-set');
    const single = (stored || []).some((c) => c.type === 'single-span');
    const values = [];
    for (let j = 0; j < Math.floor(r() * 5); j++) {
      const value = pick(r, VALUES);
      const exempt = r() < 0.3;
      const token = !single && values.length && r() < 0.3 ? values.at(-1).token : `t${j}`;
      if (exempt || !held || valueSetAllows(held, value)) values.push({ value, exempt, token });
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
  // The tokens holding more than one span of the layer.
  const doubled = (id) => {
    const n = new Map();
    for (const v of data.get(id) || []) n.set(v.token, (n.get(v.token) ?? 0) + 1);
    return [...n.values()].filter((k) => k > 1).length;
  };
  const violationsOf = (id, rules) => [
    ...refused(id, rules).map((v) => ({ constraint: 'value-set', value: v.value })),
    ...(rules.some((c) => c.type === 'single-span')
      ? Array.from({ length: doubled(id) }, () => ({ constraint: 'single-span' }))
      : []),
  ];
  const violation = (vs) =>
    Object.assign(new Error('HTTP 422'), {
      status: 422,
      responseData: { violations: vs, 'violation-count': vs.length },
    });
  const setConstraints = (id, ns, list, _doc, options) => {
    const sl = layer(id);
    const stored = sl.constraints?.[ns] ?? null;
    if (options && Object.hasOwn(options, 'expected')) {
      if (!sameConstraints(options.expected ?? null, stored)) {
        throw Object.assign(new Error('HTTP 409'), { status: 409 });
      }
    }
    const vs = violationsOf(id, list);
    if (vs.length) throw violation(vs);
    sl.constraints = { ...sl.constraints, [ns]: list };
  };
  const setConfig = (id, ns, key, value, _doc, options) => {
    const sl = layer(id);
    if (options && Object.hasOwn(options, 'expected')) {
      if ((options.expected ?? null) !== (sl.config?.[ns]?.[key] ?? null)) {
        throw Object.assign(new Error('HTTP 409'), { status: 409 });
      }
    }
    sl.config = { ...sl.config, [ns]: { ...sl.config?.[ns], [key]: value } };
  };
  const deleteConfig = (id, ns, key, _doc, options) => {
    const sl = layer(id);
    if (options && Object.hasOwn(options, 'expected')) {
      if ((options.expected ?? null) !== (sl.config?.[ns]?.[key] ?? null)) {
        throw Object.assign(new Error('HTTP 409'), { status: 409 });
      }
    }
    const { [key]: _gone, ...rest } = sl.config?.[ns] ?? {};
    sl.config = { ...sl.config, [ns]: rest };
  };
  const spanLayers = {
    setConstraints: async (...a) => setConstraints(...a),
    setConfig: async (...a) => setConfig(...a),
    deleteConfig: async (...a) => deleteConfig(...a),
    checkConstraints: async (id, rules) => {
      const vs = violationsOf(id, rules);
      return { violations: vs, violationCount: vs.length };
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
    // Joins the spans on a token: a change to the annotations.
    repairConstraints: async (id) => {
      const seen = new Set();
      data.set(
        id,
        (data.get(id) || []).filter((v) => !seen.has(v.token) && seen.add(v.token)),
      );
      return { repaired: [{ joined: 1 }] };
    },
    get: async (id) => clone(layer(id)),
  };
  const projects = {
    get: async () => clone(project),
    setConfig: async (_id, ns, key, value) => {
      project.config = { ...project.config, [ns]: { ...project.config?.[ns], [key]: value } };
    },
    deleteConfig: async (_id, ns, key) => {
      const { [key]: _gone, ...rest } = project.config?.[ns] ?? {};
      project.config = { ...project.config, [ns]: rest };
    },
  };
  const client = {
    projects,
    spanLayers,
    tokenLayers: { setConstraints: async () => {}, checkConstraints: async () => ({}) },
    withOperation: async (_m, fn) => fn(),
    // Lands whole or not at all.
    async batched(fn) {
      const saved = clone({ textLayers: project.textLayers, config: project.config });
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
      fn({
        projects: queue('projects'),
        spanLayers: queue('spanLayers'),
        tokenLayers: queue('tokenLayers'),
      });
      try {
        for (const op of ops) await op();
      } catch (e) {
        project.textLayers = saved.textLayers;
        project.config = saved.config;
        throw e;
      }
      return ops.map(() => ({ status: 200, body: {} }));
    },
  };
  return { client, layer, refused, doubled };
};

// After a heal: each field holds what its settings want, or is named for
// what stands in the way (values off its list, or a token with two spans
// where it does not hold one span a token), keeping the list it held when
// values are in the way. Returns the failures.
const checkHealed = (g, core, out, before) => {
  const fails = [];
  const names = new Set(out.notInForce.map((n) => n.layerId));
  let healed = 0;
  let named = 0;
  for (const f of g.fields) {
    const wanted = fieldConstraints(f.config, g.project.config);
    const stored = core.layer(f.id).constraints?.igt ?? null;
    const rule = wanted.find((c) => c.type === 'value-set');
    // A field whose settings want no list (no tagset, one not closed, or one
    // the project does not have) holds none after the heal.
    if (!rule && (stored || []).some((c) => c.type === 'value-set')) {
      fails.push(`${f.id} keeps a list its settings do not want`);
    }
    const inWay = rule ? core.refused(f.id, [rule]) : [];
    const was = before.get(f.id) || [];
    const hadSingle = was.some((c) => c.type === 'single-span');
    const doubles = core.doubled(f.id);
    if (sameConstraints(stored, wanted)) {
      if (names.has(f.id)) fails.push(`${f.id} in force and named`);
      if (!sameConstraints(was, wanted)) healed += 1;
      continue;
    }
    const needsRepair = !hadSingle && doubles > 0;
    if (!inWay.length && !needsRepair) fails.push(`${f.id} out of force with nothing in the way`);
    const entry = out.notInForce.find((n) => n.layerId === f.id);
    if (!entry) fails.push(`${f.id} out of force and not named`);
    else {
      if (inWay.length && entry.count !== inWay.length) {
        fails.push(`${f.id} named ${entry.count} of ${inWay.length}`);
      }
      if (
        needsRepair &&
        !(entry.repair?.includes('single-span') && entry.repairCount === doubles)
      ) {
        fails.push(`${f.id} needs a repair and is not named for it`);
      }
    }
    const heldBefore = was.filter((c) => c.type === 'value-set');
    const heldNow = (stored || []).filter((c) => c.type === 'value-set');
    if (inWay.length && !sameConstraints(heldBefore, heldNow)) {
      fails.push(`${f.id} list held changed while refused`);
    }
    const hasSingle = (stored || []).some((c) => c.type === 'single-span');
    if (hadSingle && !hasSingle) fails.push(`${f.id} lost single-span`);
    if (!doubles && !hasSingle) fails.push(`${f.id} left without single-span on clean data`);
    named += 1;
  }
  return { fails, healed, named };
};

const CASES = 3000;

const snapshotData = (data) => JSON.stringify([...data]);

describe('declareIgtRules over a generated sweep', () => {
  it('leaves every field as its settings want, or named with what is in the way, changing no annotation', async () => {
    const violations = [];
    let healed = 0;
    let named = 0;
    let repairNamed = 0;
    for (let seed = 1; seed <= CASES; seed++) {
      const g = generate(seed);
      const before = new Map(g.fields.map((f) => [f.id, clone(f.constraints?.igt ?? null)]));
      const core = fakeCore(g);
      const fail = (what) => violations.push(`seed ${seed}: ${what}`);
      const data = snapshotData(g.data);
      let out;
      try {
        out = await declareIgtRules(core.client, 'p', { fieldsOnly: true, repair: false });
      } catch (e) {
        fail(`threw ${e.message}`);
        continue;
      }
      if (snapshotData(g.data) !== data) fail('the heal changed annotations');
      const res = checkHealed(g, core, out, before);
      res.fails.forEach(fail);
      healed += res.healed;
      named += res.named;
      repairNamed += out.notInForce.filter((n) => n.repair).length;
      // What the settings screen shows agrees with the server afterwards,
      // and a second run writes nothing and names the same fields.
      const after = fieldsOutOfForce(await core.client.projects.get());
      if (after.length !== out.notInForce.length) {
        fail(`fieldsOutOfForce ${after.length} against ${out.notInForce.length} named`);
      }
      const snapshot = JSON.stringify(g.project.textLayers);
      const again = await declareIgtRules(core.client, 'p', { fieldsOnly: true, repair: false });
      if (JSON.stringify(g.project.textLayers) !== snapshot) fail('a second run wrote');
      if (again.notInForce.length !== out.notInForce.length) fail('a second run named others');
    }
    expect(violations).toEqual([]);
    // The sweep reaches every outcome often.
    expect(healed).toBeGreaterThan(CASES / 4);
    expect(named).toBeGreaterThan(CASES / 10);
    expect(repairNamed).toBeGreaterThan(CASES / 20);
  });
});

// A settings save as the app makes it (TagsetsSettings, FieldsSettings,
// Validation's Add to tagset, an assistant tagset plan): the pre-save
// question, the batch with the declarations, then the heal.
const randomSave = (r, g) => {
  const config = clone(g.project.config);
  const tagsets = config.igt.tagsets;
  const names = Object.keys(tagsets);
  const kind = pick(r, ['add', 'add', 'remove', 'mode', 'repoint', 'rename', 'delete']);
  if (kind === 'rename' && names.length) {
    const from = pick(r, names);
    const to = pick(
      r,
      ['Leipzig', 'POS', 'Other', 'Gone', 'LGR'].filter((n) => !tagsets[n]),
    );
    if (to) {
      tagsets[to] = tagsets[from];
      delete tagsets[from];
      return { kind, config, renamed: { from, to } };
    }
  }
  if (kind === 'delete' && names.length) {
    delete tagsets[pick(r, names)];
    return { kind, config };
  }
  if (kind === 'repoint' || !names.length) {
    const f = pick(r, g.fields);
    const tagset = pick(r, [...names, undefined]);
    const igt = { ...f.config.igt };
    if (tagset) igt.tagset = tagset;
    else delete igt.tagset;
    return { kind: 'repoint', config, field: f.id, fieldConfig: { ...f.config, igt } };
  }
  const t = tagsets[pick(r, names)];
  if (kind === 'add') t.values.push({ value: pick(r, [...POOL, 'QQ', 'NEW']) });
  if (kind === 'remove' && t.values.length) t.values.splice(Math.floor(r() * t.values.length), 1);
  if (kind === 'mode') t.mode = pick(r, ['closed', 'suggest', 'mixed']);
  return { kind, config };
};

// A field's settings after `save`: its own repoint, or the rename's.
const configAfter = (f, save) => {
  if (f.id === save.field) return save.fieldConfig;
  if (save.renamed && f.config?.igt?.tagset === save.renamed.from) {
    return { ...f.config, igt: { ...f.config.igt, tagset: save.renamed.to } };
  }
  return f.config;
};

const runSave = async (client, project, save) => {
  const live = await client.projects.get();
  const layers = new Map(igtFields(getIgtLayerInfo(live)).map((sl) => [sl.id, sl]));
  let rulesBeforeHeal;
  const mark = () => {
    rulesBeforeHeal = new Map(
      [...layers.keys()].map((id) => [
        id,
        clone(
          project.textLayers[0].tokenLayers.flatMap((t) => t.spanLayers).find((x) => x.id === id)
            .constraints?.igt ?? null,
        ),
      ]),
    );
  };
  if (save.field) {
    const fields = [...layers.values()].map((sl) =>
      sl.id === save.field ? { ...sl, configBefore: sl.config, config: save.fieldConfig } : sl,
    );
    const refused = await refusedBySave(client, fields, save.config, live.config);
    if (refused.length) return { refused };
    await client.batched((b) => {
      b.spanLayers.setConfig(save.field, 'igt', 'tagset', save.fieldConfig.igt.tagset);
      queueFieldDeclarations(b, fields, save.config, live.config);
    });
  } else {
    // The Tagsets screen's save, through the batch it sends.
    const next = save.config.igt.tagsets;
    const { fields, after } = tagsetsSaveFields(live, next, save.renamed ?? null);
    const refused = await refusedBySave(client, fields, after, live.config);
    if (refused.length) return { refused };
    await client.batched((b) => {
      queueTagsetsSave(b, 'p', live, next, {
        renamed: save.renamed ?? null,
        expected: live.config.igt.tagsets,
        fields,
        after,
      });
    });
  }
  mark();
  return {
    refused: [],
    rulesBeforeHeal,
    out: await declareIgtRules(client, 'p', { fieldsOnly: true, repair: false }),
  };
};

describe('a settings save over a generated sweep', () => {
  it('is refused only for a field in force whose new list the values break, and changes no annotation', async () => {
    const violations = [];
    const stats = { refused: 0, saved: 0, outOfForceSaved: 0, renamed: 0 };
    for (let seed = 1; seed <= CASES; seed++) {
      const g = generate(seed);
      const r = rng(seed * 7919);
      const save = randomSave(r, g);
      const core = fakeCore(g);
      const fail = (what) => violations.push(`seed ${seed} ${save.kind}: ${what}`);
      const data = snapshotData(g.data);
      const before = new Map(g.fields.map((f) => [f.id, clone(f.constraints?.igt ?? null)]));
      const configBefore = clone(g.project.config);
      // What the save should be refused for: a field in force before it,
      // whose rules it changes to a list the stored values break.
      const blocking = g.fields.filter((f) => {
        const cfgAfter = configAfter(f, save);
        const was = fieldConstraints(f.config, configBefore);
        const now = fieldConstraints(cfgAfter, save.config);
        if (sameConstraints(was, now)) return false;
        if (!sameConstraints(before.get(f.id), was)) return false;
        const rule = now.find((c) => c.type === 'value-set');
        return rule && core.refused(f.id, [rule]).length > 0;
      });
      const outOfForceTouched = g.fields.some((f) => {
        const cfgAfter = configAfter(f, save);
        const was = fieldConstraints(f.config, configBefore);
        return (
          !sameConstraints(was, fieldConstraints(cfgAfter, save.config)) &&
          !sameConstraints(before.get(f.id), was)
        );
      });
      let res;
      try {
        res = await runSave(core.client, g.project, save);
      } catch (e) {
        fail(`threw ${e.status ?? ''} ${e.message}`);
        continue;
      }
      if (snapshotData(g.data) !== data) fail('the save or its heal changed annotations');
      if (res.refused.length) {
        stats.refused += 1;
        const ids = new Set(blocking.map((f) => f.id));
        for (const x of res.refused) if (!ids.has(x.layerId)) fail(`refused for ${x.layerId}`);
        if (!blocking.length) fail('refused with no field in force in the way');
        if (!sameConstraints(g.project.config, configBefore)) fail('a refused save wrote');
        continue;
      }
      if (blocking.length) fail(`saved over ${blocking.map((f) => f.id)}`);
      stats.saved += 1;
      if (outOfForceTouched) stats.outOfForceSaved += 1;
      // The fields as the save left their settings.
      if (save.field) g.fields.find((f) => f.id === save.field).config = save.fieldConfig;
      for (const f of g.fields) f.config = core.layer(f.id).config;
      if (save.renamed) {
        stats.renamed += 1;
        for (const f of g.fields) {
          if (f.config?.igt?.tagset === save.renamed.from) fail(`${f.id} still names the old name`);
        }
      }
      const healed = checkHealed(g, core, res.out, before);
      healed.fails.forEach(fail);
    }
    expect(violations).toEqual([]);
    expect(stats.refused).toBeGreaterThan(CASES / 200);
    expect(stats.outOfForceSaved).toBeGreaterThan(CASES / 20);
    expect(stats.renamed).toBeGreaterThan(CASES / 20);
  });
});
