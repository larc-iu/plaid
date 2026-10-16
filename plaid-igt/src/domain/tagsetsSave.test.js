import { describe, it, expect } from 'vitest';
import {
  TAGSETS_CHANGED,
  queueStated,
  queueTagsetsSave,
  tagsetsChangedError,
  tagsetsSaveFields,
} from './tagsetsSave.js';
import { buildRawDoc } from './test-helpers.js';

// Luke's ruling on REV6-WIRE-1 (2026-10-16): a settings save states the
// tagsets it read, and one that renames or deletes a tagset states every
// field reference it leaves, so a change made elsewhere meanwhile refuses it
// ("Tagsets changed elsewhere. Reload and redo your change.").

const LEIPZIG = { delimiters: '.', mode: 'closed', values: [{ value: 'PL' }] };

const projectWith = () => {
  const p = buildRawDoc();
  const fields = p.textLayers[0].tokenLayers.flatMap((t) => t.spanLayers || []);
  fields[0].config = { igt: { ...fields[0].config?.igt, tagset: 'Leipzig' } };
  p.config = { igt: { tagsets: { Leipzig: LEIPZIG, POS: { ...LEIPZIG, mode: 'suggest' } } } };
  return p;
};

const recorder = () => {
  const calls = [];
  const bundle = (res) =>
    new Proxy(
      {},
      {
        get:
          (_, m) =>
          (...args) =>
            calls.push([res, m, ...args]),
      },
    );
  return { calls, b: { projects: bundle('projects'), spanLayers: bundle('spanLayers') } };
};

describe('a Tagsets save states what it leaves', () => {
  it('states every other field and the metadata fields when it deletes a tagset', () => {
    const live = projectWith();
    const next = { POS: live.config.igt.tagsets.POS };
    const { fields, after } = tagsetsSaveFields(live, next, null);
    const { calls, b } = recorder();
    queueTagsetsSave(b, 'p', live, next, { expected: live.config.igt.tagsets, fields, after });
    const refs = calls.filter(([res, , , , key]) => res === 'spanLayers' && key === 'tagset');
    expect(refs.length).toBe(fields.length);
    const leipzig = fields.find((f) => f.config?.igt?.tagset === 'Leipzig');
    for (const r of refs) {
      expect(r).toEqual(
        r[2] === leipzig.id
          ? [
              'spanLayers',
              'setConfig',
              r[2],
              'igt',
              'tagset',
              'Leipzig',
              undefined,
              { expected: 'Leipzig' },
            ]
          : ['spanLayers', 'deleteConfig', r[2], 'igt', 'tagset', undefined, { expected: null }],
      );
    }
    expect(calls).toContainEqual([
      'projects',
      'deleteConfig',
      'p',
      'igt',
      'documentMetadata',
      undefined,
      { expected: null },
    ]);
  });

  it('states nothing more when it only changes a tagset', () => {
    const live = projectWith();
    const next = { ...live.config.igt.tagsets, POS: { ...LEIPZIG, mode: 'mixed' } };
    const { fields, after } = tagsetsSaveFields(live, next, null);
    const { calls, b } = recorder();
    queueTagsetsSave(b, 'p', live, next, { expected: live.config.igt.tagsets, fields, after });
    expect(calls.filter(([, , , , key]) => key === 'tagset' || key === 'documentMetadata')).toEqual(
      [],
    );
  });

  it('a stated cell writes its value expecting it, an absent one a delete expecting null', () => {
    const { calls, b } = recorder();
    queueStated(b.projects, 'p', 'tagsets', { A: LEIPZIG });
    queueStated(b.projects, 'p', 'tagsets', undefined);
    expect(calls).toEqual([
      [
        'projects',
        'setConfig',
        'p',
        'igt',
        'tagsets',
        { A: LEIPZIG },
        undefined,
        { expected: { A: LEIPZIG } },
      ],
      ['projects', 'deleteConfig', 'p', 'igt', 'tagsets', undefined, { expected: null }],
    ]);
  });

  it('a cell holding JSON null is stated as null, never deleted (REV7-WIRE-7)', () => {
    const { calls, b } = recorder();
    queueStated(b.spanLayers, 's', 'tagset', null);
    expect(calls).toEqual([
      ['spanLayers', 'setConfig', 's', 'igt', 'tagset', null, undefined, { expected: null }],
    ]);
  });
});

describe('a refused save says the tagsets changed only when they did', () => {
  const conflict = Object.assign(new Error('HTTP 409'), { status: 409 });
  it('reads them again on a 409', async () => {
    const said = await tagsetsChangedError(conflict, { A: 1 }, async () => ({ A: 2 }));
    expect(said.message).toBe(TAGSETS_CHANGED);
    expect(said.tagsetsChanged).toBe(true);
    expect(await tagsetsChangedError(conflict, { A: 1 }, async () => ({ A: 1 }))).toBe(conflict);
  });
  it('leaves any other refusal as it is', async () => {
    const other = Object.assign(new Error('HTTP 422'), { status: 422 });
    expect(await tagsetsChangedError(other, { A: 1 }, async () => ({ A: 2 }))).toBe(other);
  });
});
