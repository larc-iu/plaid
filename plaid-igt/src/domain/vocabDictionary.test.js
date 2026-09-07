import { describe, it, expect } from 'vitest';
import { normalizeVocabFields } from './vocabFields.js';
import {
  buildSenseTree,
  buildItemNumbers,
  arrangeAsTree,
  groupRankedByHeadword,
  descendantsOf,
  nextSenseOrder,
  withParentSet,
  splitEntryLevel,
  planSenseDrop,
  homographGroup,
  planHomographOrder,
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

describe('splitEntryLevel', () => {
  const fields = [{ name: 'gloss' }, { name: 'etymology', scope: 'entry' }, { name: 'status' }];
  it("sends the entry's own facts up and leaves the meaning behind", () => {
    const { entry, sense } = splitEntryLevel(
      {
        gloss: 'cat',
        pos: 'N',
        homograph: 2,
        morphType: 'stem',
        lexemeForm: 'kat-',
        flexEntry: 'E1',
        flexSense: 'S1',
        etymology: 'Proto-X',
        status: 'draft',
        examples: [{ text: 'a' }],
        parent: 'p',
        senseOrder: 3,
      },
      fields,
    );
    expect(entry).toEqual({
      homograph: 2,
      morphType: 'stem',
      lexemeForm: 'kat-',
      flexEntry: 'E1',
      etymology: 'Proto-X',
    });
    expect(sense).toEqual({
      gloss: 'cat',
      pos: 'N',
      flexSense: 'S1',
      status: 'draft',
      examples: [{ text: 'a' }],
    });
  });

  it('keeps everything when the vocabulary has no headword-only field', () => {
    const { entry, sense } = splitEntryLevel({ gloss: 'cat', etymology: 'x' }, [{ name: 'gloss' }]);
    expect(entry).toEqual({});
    expect(sense).toEqual({ gloss: 'cat', etymology: 'x' });
  });
});

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

  it('resolves a sense listed before its headword to that headword', () => {
    // A raised headword is created after the sense it is raised over, so the
    // sense comes first in creation order.
    const list = [
      item('s', 'lone', { gloss: 'one', parent: 'h', senseOrder: 1 }),
      item('ss', 'lone', { gloss: 'deeper', parent: 's', senseOrder: 1 }),
      item('h', 'lone', {}),
    ];
    const t = buildSenseTree(list);
    expect(t.roots.map((r) => r.id)).toEqual(['h']);
    expect(t.rootOf.get('s')).toBe('h');
    expect(t.rootOf.get('ss')).toBe('h');
    expect(t.depthOf.get('ss')).toBe(2);
    const n = buildItemNumbers(list);
    expect([n.get('h'), n.get('s'), n.get('ss')]).toEqual(['1', '1.1', '1.1.1']);
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

  it('orders homographs by their stored number, and renumbers them on demand', () => {
    const list = [
      item('x1', 'x', { gloss: 'late', homograph: 2 }),
      item('x2', 'x', { gloss: 'early', homograph: 1 }),
      item('x3', 'x', { gloss: 'unnumbered' }),
      item('x1s', 'x', { gloss: 'a sense', parent: 'x1' }),
      item('y', 'y', {}),
    ];
    expect(homographGroup(list, 'x1s').map((r) => r.id)).toEqual(['x2', 'x1', 'x3']);
    expect(homographGroup(list, 'y')).toEqual([]);
    const n = buildItemNumbers(list);
    expect([n.get('x2'), n.get('x1'), n.get('x3'), n.get('x1s'), n.get('y')]).toEqual([
      '1',
      '2',
      '3',
      '2.1',
      '',
    ]);
    // Move the unnumbered one first: everyone whose number changes is written.
    expect(planHomographOrder(homographGroup(list, 'x1'), ['x3', 'x2', 'x1'])).toEqual([
      { id: 'x3', metadata: { gloss: 'unnumbered', homograph: 1 } },
      { id: 'x2', metadata: { gloss: 'early', homograph: 2 } },
      { id: 'x1', metadata: { gloss: 'late', homograph: 3 } },
    ]);
    expect(planHomographOrder(homographGroup(list, 'x1'), ['x2', 'x1', 'x3'])).toEqual([
      { id: 'x3', metadata: { gloss: 'unnumbered', homograph: 3 } },
    ]);
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
    // A lone headword with senses is 1, so its senses read as senses; a lone
    // headword without any has no number.
    const m = buildItemNumbers(items());
    expect(m.get('kat')).toBe('1');
    expect(m.get('kat2a')).toBe('1.2.1');
    expect(m.get('run')).toBe('');
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
    // A search that matched only the subsense and the variant: the subsense
    // sits under its entry and its sense, both shown as context.
    const some = arrangeAsTree([list[3], list[4]], t).map((r) => [r.item.id, r.depth, !!r.context]);
    expect(some).toEqual([
      ['kat', 0, true],
      ['kat2', 1, true],
      ['kat2a', 2, false],
      ['run', 0, false],
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
    // A bare id where the field takes many: the reference is kept, rewritten
    // in the field's shape, and nobody is told about it.
    expect(byId.e).toEqual({ seeAlso: ['a'] });
    expect(byId.f).toEqual({});
    expect(findings.map((f) => f.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reshapes a reference a field type change left in the other shape', () => {
    const one = fields.map((f) => (f.name === 'seeAlso' ? { ...f, many: false } : f));
    const many = fields.map((f) => (f.name === 'variantOf' ? { ...f, many: true } : f));
    const list = [
      item('a', 'a', {}),
      item('b', 'b', {}),
      // Entries narrowed to Entry: the first survives, the rest go.
      item('narrow', 'narrow', { seeAlso: ['a', 'b'] }),
      // Entry widened to Entries: the id is wrapped, nothing is lost.
      item('widen', 'widen', { variantOf: 'a' }),
    ];
    const narrowed = validateVocabRefs(list, one);
    expect(Object.fromEntries(narrowed.patches.map((p) => [p.id, p.metadata])).narrow).toEqual({
      seeAlso: 'a',
    });
    expect(narrowed.findings).toEqual([]);
    const widened = validateVocabRefs(list, many);
    expect(Object.fromEntries(widened.patches.map((p) => [p.id, p.metadata])).widen).toEqual({
      variantOf: ['a'],
    });
    expect(widened.findings).toEqual([]);
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

describe('groupRankedByHeadword', () => {
  it('shows each headword once, at its best member, with its ranked senses under it', () => {
    const list = [...items(), item('kat9', 'kat', { gloss: 'other kat' })];
    // Ranked as the popover would: the sense first (precedent), then others.
    const ranked = [
      { ...list[1], _tier: 0 }, // kat2 (sense of kat)
      { ...list[5], _tier: 1 }, // kat9
      { ...list[0], _tier: 2 }, // kat
      { ...list[3], _tier: 3 }, // kat2a (sense of kat2)
      { ...list[4], _tier: 3 }, // run
    ];
    const rows = groupRankedByHeadword(ranked, list).map((r) => [r.item.id, r.depth, !!r.context]);
    expect(rows).toEqual([
      ['kat', 0, false],
      ['kat2', 1, false],
      ['kat2a', 2, false],
      ['kat9', 0, false],
      ['run', 0, false],
    ]);
    // The rank annotations ride along on the ranked rows.
    expect(groupRankedByHeadword(ranked, list)[1].item._tier).toBe(0);
  });

  it('shows an unranked headword as context above a ranked sense', () => {
    const list = items();
    const ranked = [{ ...list[3], _tier: 0 }]; // only kat2a matched
    expect(
      groupRankedByHeadword(ranked, list).map((r) => [r.item.id, r.depth, !!r.context]),
    ).toEqual([
      ['kat', 0, true],
      ['kat2', 1, true],
      ['kat2a', 2, false],
    ]);
  });
});
