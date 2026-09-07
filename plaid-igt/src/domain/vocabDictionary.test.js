import { describe, it, expect } from 'vitest';
import { normalizeVocabFields } from './vocabFields.js';
import {
  buildSenseTree,
  buildItemNumbers,
  arrangeAsTree,
  descendantsOf,
  nextSenseOrder,
  withParentSet,
  planSenseMove,
  planSenseSetNumber,
  planSenseDrop,
  referencesTo,
  validateVocabRefs,
  planDeleteRefs,
  planMergeRefs,
  fieldsForItem,
  withExampleAdded,
  withExampleRemoved,
  allExamples,
  exampleRefs,
  refIds,
  withRefIds,
} from './vocabDictionary.js';

const item = (id, form, metadata) => ({ id, form, ...(metadata ? { metadata } : {}) });
const fields = normalizeVocabFields({
  gloss: { inline: true },
  variantOf: { inline: false, type: 'item' },
  seeAlso: { inline: false, type: 'item', many: true },
  etymology: { inline: false, scope: 'entry' },
});

// kat: an entry with two senses, the second with a subsense. run: a variant.
const items = () => [
  item('kat', 'kat', { gloss: 'cat' }),
  item('kat2', 'kat', { gloss: 'lion', parent: 'kat', senseOrder: 2 }),
  item('kat3', 'kat', { gloss: 'scratch', parent: 'kat', senseOrder: 1 }),
  item('kat2a', 'kat', { gloss: 'lioness', parent: 'kat2' }),
  item('run', 'run', { gloss: 'run', variantOf: 'kat', seeAlso: ['kat', 'kat2'] }),
];

describe('buildSenseTree', () => {
  it('leaves an entry unnumbered and numbers its senses from 1, subsenses under them', () => {
    const t = buildSenseTree(items());
    expect(t.roots.map((r) => r.id)).toEqual(['kat', 'run']);
    expect(t.childrenOf.get('kat').map((c) => c.id)).toEqual(['kat3', 'kat2']);
    expect(t.numberOf.get('kat')).toBe('');
    expect(t.numberOf.get('kat3')).toBe('1');
    expect(t.numberOf.get('kat2')).toBe('2');
    expect(t.numberOf.get('kat2a')).toBe('2.1');
    expect(t.depthOf.get('kat2a')).toBe(2);
    expect(t.rootOf.get('kat2a')).toBe('kat');
    expect(descendantsOf(t, 'kat').map((c) => c.id)).toEqual(['kat3', 'kat2', 'kat2a']);
  });

  it('treats a missing or looping parent as none', () => {
    const t = buildSenseTree([
      item('a', 'a', { parent: 'zzz' }),
      item('b', 'b', { parent: 'c' }),
      item('c', 'c', { parent: 'b' }),
      item('d', 'd', { parent: 'd' }),
    ]);
    expect(t.roots.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(t.numberOf.get('c')).toBe('');
  });

  it('orders unnumbered siblings after numbered ones, by creation', () => {
    const t = buildSenseTree([
      item('p', 'p'),
      item('x', 'x', { parent: 'p' }),
      item('y', 'y', { parent: 'p', senseOrder: 5 }),
      item('z', 'z', { parent: 'p' }),
    ]);
    expect(t.childrenOf.get('p').map((c) => c.id)).toEqual(['y', 'x', 'z']);
    expect(nextSenseOrder(t, 'p')).toBe(6);
    expect(nextSenseOrder(t, 'x')).toBe(1);
  });
});

describe('placing and moving senses', () => {
  it('appends a new sense last and detaches back to an entry', () => {
    const list = items();
    const t = buildSenseTree(list);
    expect(withParentSet(t, list[4], 'kat')).toMatchObject({ parent: 'kat', senseOrder: 3 });
    const freed = withParentSet(t, list[1], null);
    expect(freed).not.toHaveProperty('parent');
    expect(freed).not.toHaveProperty('senseOrder');
    expect(freed.gloss).toBe('lion');
  });

  it('moves a sense among its siblings by renumbering them densely', () => {
    const t = buildSenseTree(items());
    // kat3 (order 1), kat2 (order 2): move kat2 up
    expect(planSenseMove(t, 'kat2', -1)).toEqual([
      { id: 'kat2', metadata: { gloss: 'lion', parent: 'kat', senseOrder: 1 } },
      { id: 'kat3', metadata: { gloss: 'scratch', parent: 'kat', senseOrder: 2 } },
    ]);
    expect(planSenseMove(t, 'kat3', -1)).toEqual([]);
    expect(planSenseMove(t, 'kat', 1)).toEqual([]);
  });

  it('places a sense at the number it is shown with', () => {
    const t = buildSenseTree(items());
    // kat3 is shown as 1, kat2 as 2: ask for kat3 to be 2.
    expect(planSenseSetNumber(t, 'kat3', 2)).toEqual([
      { id: 'kat2', metadata: { gloss: 'lion', parent: 'kat', senseOrder: 1 } },
      { id: 'kat3', metadata: { gloss: 'scratch', parent: 'kat', senseOrder: 2 } },
    ]);
    // Already there, out of range, or not a number: nothing.
    expect(planSenseSetNumber(t, 'kat3', 1)).toEqual([]);
    expect(planSenseSetNumber(t, 'kat3', 0)).toEqual([]);
    expect(planSenseSetNumber(t, 'kat2', 99)).toEqual([]);
    expect(planSenseSetNumber(t, 'kat2', 'x')).toEqual([]);
    expect(planSenseSetNumber(t, 'kat2a', 1)).toEqual([]);
  });

  it('gives every item one dotted number, entries told apart by a first segment', () => {
    const list = [...items(), item('kat9', 'kat', { gloss: 'other kat' })];
    const n = buildItemNumbers(list);
    expect(n.get('kat')).toBe('1');
    expect(n.get('kat9')).toBe('2');
    expect(n.get('kat3')).toBe('1.1');
    expect(n.get('kat2')).toBe('1.2');
    expect(n.get('kat2a')).toBe('1.2.1');
    expect(n.get('run')).toBe('');
    // A lone entry's senses carry no entry segment.
    const m = buildItemNumbers(items());
    expect(m.get('kat')).toBe('');
    expect(m.get('kat2a')).toBe('2.1');
  });

  it('lands a dragged sense before, after, into, or out', () => {
    const t = buildSenseTree(items());
    const by = (patches) => Object.fromEntries(patches.map((p) => [p.id, p.metadata]));
    // kat3 (2), kat2 (3, with kat2a under it)
    expect(by(planSenseDrop(t, 'kat3', { kind: 'after', id: 'kat2' }))).toEqual({
      kat2: { gloss: 'lion', parent: 'kat', senseOrder: 1 },
      kat3: { gloss: 'scratch', parent: 'kat', senseOrder: 2 },
    });
    // Into kat2: last under it, and its unnumbered sense gets a number too.
    expect(by(planSenseDrop(t, 'kat3', { kind: 'into', id: 'kat2' }))).toEqual({
      kat2a: { gloss: 'lioness', parent: 'kat2', senseOrder: 1 },
      kat3: { gloss: 'scratch', parent: 'kat2', senseOrder: 2 },
    });
    expect(by(planSenseDrop(t, 'kat2a', { kind: 'before', id: 'kat3' }))).toEqual({
      kat2a: { gloss: 'lioness', parent: 'kat', senseOrder: 1 },
      kat3: { gloss: 'scratch', parent: 'kat', senseOrder: 2 },
      kat2: { gloss: 'lion', parent: 'kat', senseOrder: 3 },
    });
    expect(planSenseDrop(t, 'kat2', { kind: 'root' })).toEqual([
      { id: 'kat2', metadata: { gloss: 'lion' } },
    ]);
    // Before an entry means first under it; a whole entry can move under another.
    expect(by(planSenseDrop(t, 'run', { kind: 'before', id: 'kat' }))).toMatchObject({
      run: { parent: 'kat', senseOrder: 1 },
      kat3: { senseOrder: 2 },
      kat2: { senseOrder: 3 },
    });
    // Nothing: onto itself, into its own subtree, already an entry, unknown.
    expect(planSenseDrop(t, 'kat2', { kind: 'into', id: 'kat2a' })).toEqual([]);
    expect(planSenseDrop(t, 'kat2', { kind: 'after', id: 'kat2' })).toEqual([]);
    expect(planSenseDrop(t, 'kat', { kind: 'root' })).toEqual([]);
    expect(planSenseDrop(t, 'kat', { kind: 'into', id: 'zzz' })).toEqual([]);
  });

  it('lays out a filtered list as a tree without hiding or adding hits', () => {
    const list = items();
    const t = buildSenseTree(list);
    const all = arrangeAsTree(list, t).map((r) => [r.item.id, r.depth]);
    expect(all).toEqual([
      ['kat', 0],
      ['kat3', 1],
      ['kat2', 1],
      ['kat2a', 2],
      ['run', 0],
    ]);
    // A search that matched only the subsense and the variant.
    const some = arrangeAsTree([list[3], list[4]], t).map((r) => [r.item.id, r.depth]);
    expect(some).toEqual([
      ['kat2a', 0],
      ['run', 0],
    ]);
  });
});

describe('references', () => {
  it('reads and writes single and many reference fields', () => {
    const [, variantOf, seeAlso] = [fields[0], fields[2], fields[3]];
    const run = items()[4];
    expect(refIds(run, variantOf)).toEqual(['kat']);
    expect(refIds(run, seeAlso)).toEqual(['kat', 'kat2']);
    expect(withRefIds(run.metadata, seeAlso, ['kat2', 'kat2'])).toMatchObject({
      seeAlso: ['kat2'],
    });
    expect(withRefIds(run.metadata, variantOf, [])).not.toHaveProperty('variantOf');
  });

  it('lists what refers to an entry, senses included', () => {
    const refs = referencesTo(items(), fields, 'kat').map((r) => [
      r.item.id,
      r.field?.name ?? null,
    ]);
    expect(refs).toEqual([
      ['kat2', null],
      ['kat3', null],
      ['run', 'variantOf'],
      ['run', 'seeAlso'],
    ]);
  });

  it('shows entry-scope fields on an entry only, and only with the switch on', () => {
    const list = items();
    const names = (it, on) => fieldsForItem(fields, it, on).map((f) => f.name);
    expect(names(list[0], true)).toContain('etymology');
    expect(names(list[1], true)).not.toContain('etymology');
    expect(names(list[1], false)).toContain('etymology');
  });
});

describe('validateVocabRefs', () => {
  it('finds nothing wrong with a sound vocabulary', () => {
    expect(validateVocabRefs(items(), fields)).toEqual({ patches: [], findings: [] });
  });

  it('clears dangling parents and references, cuts cycles, drops junk', () => {
    const list = [
      item('a', 'a', { parent: 'gone', senseOrder: 1, gloss: 'x' }),
      item('b', 'b', { parent: 'c' }),
      item('c', 'c', { parent: 'b' }),
      item('d', 'd', { variantOf: 'gone', seeAlso: ['a', 'gone', 'd'] }),
      item('e', 'e', { seeAlso: 'a' }),
      item('f', 'f', { senseOrder: 3 }),
    ];
    const { patches, findings } = validateVocabRefs(list, fields);
    const byId = Object.fromEntries(patches.map((p) => [p.id, p.metadata]));
    expect(byId.a).toEqual({ gloss: 'x' });
    expect(byId.b).toEqual({});
    expect(byId.c).toEqual({});
    expect(byId.d).toEqual({ seeAlso: ['a'] });
    expect(byId.e).toEqual({});
    expect(byId.f).toEqual({});
    expect(findings.map((f) => f.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('delete and merge', () => {
  it('frees the senses of a deleted entry and drops references to it', () => {
    const patches = planDeleteRefs(items(), fields, ['kat']);
    expect(patches).toEqual([
      { id: 'kat2', metadata: { gloss: 'lion' } },
      { id: 'kat3', metadata: { gloss: 'scratch' } },
      { id: 'run', metadata: { gloss: 'run', seeAlso: ['kat2'] } },
    ]);
  });

  it('repoints references and senses at the survivor of a merge', () => {
    const list = [...items(), item('kat4', 'kat', { gloss: 'tomcat' })];
    const patches = planMergeRefs(list, fields, 'kat4', ['kat']);
    const byId = Object.fromEntries(patches.map((p) => [p.id, p.metadata]));
    expect(byId.kat2).toMatchObject({ parent: 'kat4', senseOrder: 1 });
    expect(byId.kat3).toMatchObject({ parent: 'kat4', senseOrder: 2 });
    expect(byId.run).toEqual({ gloss: 'run', variantOf: 'kat4', seeAlso: ['kat4', 'kat2'] });
    expect(byId.kat2a).toBeUndefined();
  });

  it('lifts a survivor out from under a losing parent', () => {
    const patches = planMergeRefs(items(), fields, 'kat2a', ['kat2']);
    const byId = Object.fromEntries(patches.map((p) => [p.id, p.metadata]));
    expect(byId.kat2a).toMatchObject({ parent: 'kat', senseOrder: 3 });
    expect(byId.run.seeAlso).toEqual(['kat', 'kat2a']);
  });

  // Only the API or another app can write a parent that points at its own
  // entry; the walk up past losing ancestors used to follow it forever.
  it('terminates when a losing ancestor points at itself', () => {
    const list = [item('a', 'a', { parent: 'a' }), item('b', 'b', { parent: 'a' })];
    const patches = planMergeRefs(list, fields, 'b', ['a']);
    expect(Object.fromEntries(patches.map((p) => [p.id, p.metadata])).b).toEqual({});
  });
});

describe('examples', () => {
  it('adds a reference once and removes by position, keeping imported text', () => {
    const meta = { examples: [{ text: 'imported', translation: 'x' }] };
    const added = withExampleAdded(meta, { document: 'd', token: 't' });
    expect(allExamples({ metadata: added })).toHaveLength(2);
    expect(exampleRefs({ metadata: added })).toEqual([{ document: 'd', token: 't' }]);
    expect(withExampleAdded(added, { document: 'd', token: 't' })).toBe(added);
    expect(withExampleRemoved(added, 0)).toEqual({ examples: [{ document: 'd', token: 't' }] });
    expect(withExampleRemoved(withExampleRemoved(added, 0), 0)).toEqual({});
  });
});
