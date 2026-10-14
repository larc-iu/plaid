import { describe, it, expect } from 'vitest';
import { isTagsetPlan, writeTagsetPlan } from './tagsetPlan.js';
import { buildRawDoc } from './test-helpers.js';

const LEIPZIG = {
  delimiters: '.',
  mode: 'mixed',
  values: [{ value: 'PL', description: 'plural' }],
};

// A project as `projects.get` gives it: the raw doc's layers, the gloss field
// (msl-0) on Leipzig and holding IGT's rules, and a metadata field on it too.
const projectWith = (tagsets = { Leipzig: LEIPZIG }) => {
  const p = buildRawDoc();
  const gloss = p.textLayers[0].tokenLayers[2].spanLayers[0];
  gloss.config = { igt: { scope: 'Morpheme', tagset: 'Leipzig' } };
  gloss.constraints = { igt: [{ type: 'single-span' }] };
  for (const tk of p.textLayers[0].tokenLayers) {
    for (const sl of tk.spanLayers) sl.constraints ??= { igt: [{ type: 'single-span' }] };
  }
  p.config = { igt: { tagsets, documentMetadata: [{ name: 'Kind', tagset: 'Leipzig' }] } };
  return p;
};

const fakeClient = (project, vocab = null, refuse = null) => {
  const calls = [];
  const rec = (res) =>
    new Proxy(
      {},
      {
        get:
          (_, method) =>
          (...args) =>
            calls.push([res, method, ...args]),
      },
    );
  return {
    calls,
    batches: 0,
    projects: { get: async () => project },
    vocabLayers: { get: async () => vocab },
    async batched(fn) {
      this.batches += 1;
      fn({
        projects: rec('projects'),
        spanLayers: rec('spanLayers'),
        vocabLayers: rec('vocabLayers'),
      });
      if (refuse) throw refuse;
    },
  };
};

const setTagset = (after, extra = {}) => ({
  kind: 'set_tagset',
  owner: 'project',
  was: 'Leipzig',
  name: 'Leipzig',
  before: LEIPZIG,
  after,
  ...extra,
});

describe('a plan of tagset changes, written with the approver’s session', () => {
  it('is a plan of settings kinds only', () => {
    expect(isTagsetPlan({ ops: [setTagset(LEIPZIG)] })).toBe(true);
    expect(isTagsetPlan({ ops: [setTagset(LEIPZIG), { kind: 'set_span' }] })).toBe(false);
    expect(isTagsetPlan({ ops: [] })).toBe(false);
  });

  it('closes a list with the field’s value set in the same batch', async () => {
    const closed = { ...LEIPZIG, mode: 'closed' };
    const c = fakeClient(projectWith());
    expect(await writeTagsetPlan(c, 'proj-1', { ops: [setTagset(closed)] })).toBe(true);
    expect(c.batches).toBe(1);
    const config = c.calls.find(
      ([r, m, , , key]) => r === 'projects' && m === 'setConfig' && key === 'tagsets',
    );
    expect(config[5]).toEqual({ Leipzig: closed });
    expect(config[7]).toEqual({ expected: { Leipzig: LEIPZIG } });
    const declared = c.calls.find(
      ([r, m, id]) => r === 'spanLayers' && m === 'setConstraints' && id === 'msl-0',
    );
    expect(declared[4]).toEqual([
      { type: 'single-span' },
      { type: 'value-set', values: ['PL'], delimiters: '.', parts: 'all' },
    ]);
    // No other field's rules change.
    expect(c.calls.filter(([, m]) => m === 'setConstraints')).toHaveLength(1);
  });

  it('writes nothing when the settings already read as planned, so a second approval is safe', async () => {
    const closed = { ...LEIPZIG, mode: 'closed' };
    const c = fakeClient(projectWith({ Leipzig: closed }));
    expect(await writeTagsetPlan(c, 'proj-1', { ops: [setTagset(closed)] })).toBe(false);
    expect(c.batches).toBe(0);
  });

  it('refuses, writing nothing, when a tagset changed since the plan', async () => {
    const c = fakeClient(projectWith({ Leipzig: { ...LEIPZIG, mode: 'suggest' } }));
    await expect(
      writeTagsetPlan(c, 'proj-1', { ops: [setTagset({ ...LEIPZIG, mode: 'closed' })] }),
    ).rejects.toThrow(/changed since it was made/);
    expect(c.batches).toBe(0);
  });

  it('carries a rename to every field that used the old name', async () => {
    const c = fakeClient(projectWith());
    await writeTagsetPlan(c, 'proj-1', { ops: [setTagset(LEIPZIG, { name: 'Glosses' })] });
    const tagsets = c.calls.find(([, m, , , key]) => m === 'setConfig' && key === 'tagsets');
    expect(Object.keys(tagsets[5])).toEqual(['Glosses']);
    expect(c.calls).toContainEqual([
      'spanLayers',
      'setConfig',
      'msl-0',
      'igt',
      'tagset',
      'Glosses',
      undefined,
      { expected: 'Leipzig' },
    ]);
    const meta = c.calls.find(([, m, , , key]) => m === 'setConfig' && key === 'documentMetadata');
    expect(meta[5]).toEqual([{ name: 'Kind', tagset: 'Glosses' }]);
  });

  it('assigns and clears a field’s tagset', async () => {
    const c = fakeClient(projectWith());
    await writeTagsetPlan(c, 'proj-1', {
      ops: [
        {
          kind: 'assign_tagset',
          owner: 'project',
          fieldKind: 'span',
          key: 'wsl-0',
          before: null,
          after: 'Leipzig',
        },
        {
          kind: 'assign_tagset',
          owner: 'project',
          fieldKind: 'span',
          key: 'msl-0',
          before: 'Leipzig',
          after: null,
        },
      ],
    });
    expect(c.calls).toContainEqual([
      'spanLayers',
      'setConfig',
      'wsl-0',
      'igt',
      'tagset',
      'Leipzig',
      undefined,
      { expected: null },
    ]);
    expect(c.calls).toContainEqual([
      'spanLayers',
      'deleteConfig',
      'msl-0',
      'igt',
      'tagset',
      undefined,
      { expected: 'Leipzig' },
    ]);
  });

  it('keeps the keys a stored value carries, which the record recased', async () => {
    const stored = { ...LEIPZIG, values: [{ value: 'PL', description: 'plural', flex_id: 'x1' }] };
    const c = fakeClient(projectWith({ Leipzig: stored }));
    const after = { ...LEIPZIG, values: [{ value: 'PL', description: 'many', flexId: 'x1' }] };
    await writeTagsetPlan(c, 'proj-1', { ops: [setTagset(after, { before: stored })] });
    const tagsets = c.calls.find(([, m, , , key]) => m === 'setConfig' && key === 'tagsets');
    expect(tagsets[5].Leipzig.values).toEqual([
      { value: 'PL', description: 'many', flex_id: 'x1' },
    ]);
  });

  it('says which stored values a closed list breaks when core refuses it', async () => {
    const refusal = Object.assign(new Error('422'), {
      status: 422,
      responseData: {
        violations: [{ constraint: 'value-set', layerName: 'Gloss', value: 'dog' }],
        'violation-count': 1,
      },
    });
    const c = fakeClient(projectWith(), null, refusal);
    await expect(
      writeTagsetPlan(c, 'proj-1', { ops: [setTagset({ ...LEIPZIG, mode: 'closed' })] }),
    ).rejects.toThrow('1 value in Gloss is not in the tagset: dog. Nothing was written.');
  });

  it('writes a lexicon’s own tagsets and an undeclared core field with its default spec', async () => {
    const vocab = { id: 'v1', config: { igt: { fields: { pos: { inline: true } } } } };
    const c = fakeClient(projectWith(), vocab);
    await writeTagsetPlan(c, 'proj-1', {
      ops: [
        {
          kind: 'set_tagset',
          owner: 'v1',
          was: 'Cat',
          name: 'Cat',
          before: null,
          after: { delimiters: '', mode: 'closed', values: [{ value: 'n' }] },
        },
        {
          kind: 'assign_tagset',
          owner: 'v1',
          fieldKind: 'entry_field',
          key: 'gloss',
          before: null,
          after: 'Cat',
        },
      ],
    });
    expect(c.calls).toContainEqual([
      'vocabLayers',
      'setConfig',
      'v1',
      'igt',
      'tagsets',
      { Cat: { delimiters: '', mode: 'closed', values: [{ value: 'n' }] } },
      undefined,
      { expected: null },
    ]);
    const fields = c.calls.find(([, m, , , key]) => m === 'setConfig' && key === 'fields');
    expect(fields[5]).toEqual({ pos: { inline: true }, gloss: { inline: true, tagset: 'Cat' } });
    expect(c.calls.some(([r]) => r === 'projects')).toBe(false);
  });

  it('writes a list with duplicates and a null description so that it reads back as planned', async () => {
    const stored = {
      ...LEIPZIG,
      values: [
        { value: 'PL', description: null, flex_id: 'a' },
        { value: 'PL ', flex_id: 'dup' },
      ],
    };
    // As the plan holds it: normalized, the first of a duplicate, keys recased.
    const before = { ...LEIPZIG, values: [{ value: 'PL', description: null, flexId: 'a' }] };
    const after = { ...before, values: [...before.values, { value: 'NOM' }] };
    const project = projectWith({ Leipzig: stored });
    const c = fakeClient(project);
    const plan = { ops: [setTagset(after, { before })] };
    expect(await writeTagsetPlan(c, 'proj-1', plan)).toBe(true);
    const written = c.calls.find(([, m, , , key]) => m === 'setConfig' && key === 'tagsets')[5];
    expect(written.Leipzig.values).toEqual([{ value: 'PL', flex_id: 'a' }, { value: 'NOM' }]);
    // Approved again over what was written: nothing more to write.
    project.config.igt.tagsets = written;
    expect(await writeTagsetPlan(fakeClient(project), 'proj-1', plan)).toBe(false);
  });
});
