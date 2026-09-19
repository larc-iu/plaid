// The value lattices behind the attribute picker: coarse values above the
// finer ones they are ambiguous between, as the guidelines draw them
// (Part 3-1-1 aspect, 3-3-5 person and number). An annotator picks the
// coarsest value they are sure of, and refines it when the language marks
// the distinction.
//
// A lattice is a tree here: a value that sits under two parents
// (atelic-process, under both imperfective and process) appears twice, and
// `pathTo` finds its first appearance. What the tree carries is the VALUE
// text as it is written after the relation, so the picker and the set check
// in validate.js agree by construction.

import { ATTRIBUTES } from './format/inventory.js';

const n = (value, children = []) => ({ value, children });

// The 2022 aspect lattice. generic sits with habitual at the top, iterative
// under activity (repetitive and ongoing) and inceptive under performance (a
// start reached), the three the schema added after the figure was drawn.
const ATELIC_PROCESS = n('atelic-process', [
  n('activity', [n('undirected-activity'), n('directed-activity'), n('iterative')]),
]);

export const ASPECT_LATTICE = [
  n('habitual'),
  n('generic'),
  n('imperfective', [
    n('state', [
      n('reversible-state'),
      n('irreversible-state'),
      n('inherent-state'),
      n('point-state'),
    ]),
    ATELIC_PROCESS,
  ]),
  n('process', [
    ATELIC_PROCESS,
    n('perfective', [
      n('endeavor', [n('semelfactive'), n('undirected-endeavor'), n('directed-endeavor')]),
      n('performance', [
        n('inceptive'),
        n('incremental-accomplishment'),
        n('nonincremental-accomplishment'),
        n('directed-achievement', [
          n('reversible-directed-achievement'),
          n('irreversible-directed-achievement'),
        ]),
      ]),
    ]),
  ]),
];

// Cysouw's person lattice: the coarse non-3rd and non-1st above the familiar
// three, clusivity under 1st. 4th is the validator's (obviative) addition.
export const PERSON_LATTICE = [
  n('non-3rd', [n('1st', [n('1st-inclusive'), n('1st-exclusive')]), n('2nd')]),
  n('non-1st', [n('2nd'), n('3rd'), n('4th')]),
];

// Corbett's number lattice: singular against non-singular, and the finer
// counts under non-singular.
export const NUMBER_LATTICE = [
  n('singular'),
  n('non-singular', [
    n('dual'),
    n('non-dual-paucal', [
      n('paucal', [n('trial'), n('non-trial-paucal')]),
      n('plural', [n('greater-plural')]),
    ]),
  ]),
];

// The spelling the validator wants for one number value, which the schema
// tables write without the hyphen.
const SPELLINGS = { nonsingular: 'non-singular' };

const LATTICES = {
  ':aspect': ASPECT_LATTICE,
  ':refer-person': PERSON_LATTICE,
  ':refer-number': NUMBER_LATTICE,
};

// The value set the picker offers for a relation. The validator's set where
// it has one, else the schema's list, since an open set is no help to a
// picker. Spellings are the validator's.
export const valuesFor = (rel, sets = 'validator') => {
  const byset = ATTRIBUTES[rel];
  if (!byset) return [];
  const values = byset[sets]?.length
    ? byset[sets]
    : byset.validator.length
      ? byset.validator
      : byset.schema;
  return [...new Set(values.map((v) => SPELLINGS[v] || v))];
};

// A relation's lattice, cut down to `allowed` values: a value outside the
// set is dropped and its children join its parent's line, so nothing under
// it goes out of reach. Null for a relation without one.
export const latticeFor = (rel, allowed) => {
  const tree = LATTICES[rel];
  if (!tree) return null;
  const keep = new Set(allowed);
  const cut = (nodes) =>
    nodes.flatMap((node) => {
      const children = cut(node.children);
      return keep.has(node.value) ? [n(node.value, children)] : children;
    });
  return cut(tree);
};

// The path of values from a top-level value down to `value`, or null when
// the lattice does not have it.
export const pathTo = (lattice, value) => {
  for (const node of lattice) {
    if (node.value === value) return [value];
    const below = pathTo(node.children, value);
    if (below) return [node.value, ...below];
  }
  return null;
};

// The lines the picker shows for a value: the top level, then the children
// of each value on the path to it. An unset or unknown value shows the top
// level alone. Each line says which of its values is on the path.
export const linesFor = (lattice, value) => {
  const path = (value && pathTo(lattice, value)) || [];
  const lines = [];
  let level = lattice;
  for (let i = 0; i <= path.length; i += 1) {
    if (!level.length) break;
    lines.push({ values: level.map((x) => x.value), on: path[i] ?? null });
    const next = level.find((x) => x.value === path[i]);
    level = next ? next.children : [];
  }
  return lines;
};

/** Every value a lattice holds, once each, in tree order. */
export const latticeValues = (lattice) => {
  const out = [];
  const walk = (nodes) =>
    nodes.forEach((node) => {
      if (!out.includes(node.value)) out.push(node.value);
      walk(node.children);
    });
  walk(lattice);
  return out;
};
