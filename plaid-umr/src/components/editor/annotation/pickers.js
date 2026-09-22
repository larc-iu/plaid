// What the canvas's editors offer: roles for a relation, concepts for a node
// (the frame files and the project's vocabularies join in), the rest.
import {
  ARG_ROLES,
  ROLES,
  ABSTRACT_CONCEPTS,
  ROLESETS_91,
  DISCOURSE_CONCEPTS,
} from '../../../domain/format/inventory.js';
import { sensesFor, rolesetsStartingWith, argsOf, argSummary } from '../../../domain/lexicon.js';
import {
  EMPTY_LEXICON,
  argsOfEntry,
  entriesStartingWith,
  entryLabel,
} from '../../../domain/vocabLexicon.js';
import { DOC_RELATIONS, DOC_CONSTANTS } from '../../../domain/format/inventory.js';
import { relationProblem, attrValueProblem } from '../../../domain/format/penman.js';

// The relations of one document-level group, the validator's set first.
export const docRelationOptions = (group, sets = 'validator') => {
  const byset = DOC_RELATIONS?.[group] || {};
  const items = byset[sets] || byset.validator || byset.schema || [];
  return [{ group: group.charAt(0).toUpperCase() + group.slice(1), items }];
};

// The conceivers: a triple to one of these is modal, to any other constant
// temporal.
export const MODAL_CONSTANTS = ['author', 'root', 'null-conceiver', 'have-condition-91'];
export const groupOfConstant = (name) => (MODAL_CONSTANTS.includes(name) ? 'modal' : 'temporal');
export const TEMPORAL_CONSTANTS = DOC_CONSTANTS.filter((c) => !MODAL_CONSTANTS.includes(c));

// Every node of the document as an option, `var concept`, sentence by sentence.
export const nodeOptions = (graph, exceptId = null) =>
  graph.sentences.map((s) => ({
    group: `Sentence ${s.index}`,
    items: s.nodes
      .filter((n) => n.id !== exceptId && n.var)
      .map((n) => ({ value: n.var, label: `${n.var} ${n.concept}`, nodeId: n.id })),
  }));

const flat = (v) => (Array.isArray(v) ? v : Object.values(v || {}).flat());

const uniq = (list) => [...new Set(list.filter(Boolean))];
const uniqEntries = (list) => {
  const seen = new Set();
  return list.filter((e) => e && !seen.has(e.id) && seen.add(e.id));
};

// Roles for an edge out of `parentConcept`: the parent's own arguments
// first, with what each means, from the bundled frame file or, for a
// project keeping its own rolesets, from the vocabulary entry.
const parentArgs = (frames, lexicon, parentConcept) => {
  if (!parentConcept) return [];
  const known = argsOf(frames, parentConcept);
  return known.length ? known : argsOfEntry(lexicon, parentConcept);
};

export const roleOptions = (frames = null, parentConcept = null, lexicon = null) => {
  // Once: the vocabulary answer walks the entries, and a dictionary is long.
  const own = parentArgs(frames, lexicon, parentConcept);
  return [
    ...(own.length
      ? [
          {
            group: parentConcept,
            items: own.map((a) => ({ value: a.role, label: `${a.role} ${a.description}` })),
          },
        ]
      : []),
    { group: 'Core', items: ARG_ROLES },
    { group: 'Participant', items: flat(ROLES.participant) },
    { group: 'Non-participant', items: flat(ROLES.nonParticipant) },
    { group: 'Spatial', items: flat(ROLES.spatial) },
    { group: 'Discourse', items: flat(ROLES.discourse) },
  ];
};

// A role typed without its colon gets one. A label picked from a list
// (`:ARG0 giver`) is the role alone.
export const normalizeRole = (text) => {
  const t = String(text || '')
    .trim()
    .split(/\s+/)[0];
  if (!t) return '';
  return t.startsWith(':') ? t : `:${t}`;
};

// Concepts for a node anchored to `words`: the frame file's senses of those
// words first (with their arguments), then the surface forms, then the
// abstract inventory. `typed` adds rolesets starting with what was typed,
// for a node with no word to go on.
const nameOf = (c) => (typeof c === 'string' ? c : c.name);
// The inventory's groups never change: built once.
const STATIC_CONCEPT_GROUPS = [
  { group: 'Abstract', items: uniq(flat(ABSTRACT_CONCEPTS).map(nameOf)) },
  { group: 'Rolesets', items: uniq(flat(ROLESETS_91).map(nameOf)) },
  {
    group: 'Discourse',
    items: uniq(flat(DISCOURSE_CONCEPTS.validator || DISCOURSE_CONCEPTS).map(nameOf)),
  },
];

//
// `vocab` is the project's vocabularies: the entries linked from the node's
// words (`linked`, offered first, the annotator chose them once already)
// and the lexicon the typed text searches.
export const conceptOptions = (words = [], frames = null, typed = '', vocab = null) => {
  const senses = uniq(words.flatMap((w) => sensesFor(frames, w.text).map((x) => x.id)));
  const byPrefix = typed && !words.length ? rolesetsStartingWith(frames, typed) : [];
  const senseItem = (id) => ({ value: id, label: `${id} ${argSummary(frames?.[id])}` });
  const surface = uniq(words.map((w) => w.text));
  const entries = vocab
    ? uniqEntries([
        ...(vocab.linked || []),
        ...(typed ? entriesStartingWith(vocab.lexicon || EMPTY_LEXICON, typed) : []),
      ])
    : [];
  const entryItem = (e) => ({ value: e.concept, label: entryLabel(e), entryId: e.id });
  return [
    ...(senses.length ? [{ group: 'Senses', items: senses.map(senseItem) }] : []),
    ...(entries.length ? [{ group: 'Vocabulary', items: entries.map(entryItem) }] : []),
    ...(byPrefix.length
      ? [{ group: 'Rolesets', items: byPrefix.map((x) => senseItem(x.id)) }]
      : []),
    ...(surface.length ? [{ group: 'Word', items: surface }] : []),
    ...STATIC_CONCEPT_GROUPS,
  ];
};

// Words of a sentence as options for a new node: the label shows the index.
export const wordOptions = (words = []) =>
  words.map((w) => ({ value: `${w.index}`, label: `${w.index} ${w.text}`, word: w }));

// One line of attributes to and from a node's `attrs`. A string value keeps
// its quotes, which is what the raw PENMAN token carries.
export const attrsToLine = (attrs) => attrs.map((a) => `${a.rel} ${a.value}`).join(' ');

/**
 * One line of attributes, and why it cannot be read, rather than what a
 * scanner could pick out of it: `:wiki Barack Obama` dropped Obama, and
 * `quant 4`, a forgotten colon, read as nothing and deleted the attribute it
 * was typed over.
 *
 * @returns {{ attrs: {rel: string, value: string}[], problem: string|null }}
 */
export const readAttrLine = (line) => {
  const attrs = [];
  let rest = String(line ?? '').trim();
  const fail = (problem) => ({ attrs, problem });
  while (rest) {
    const rel = /^(:[^\s]*)(\s+|$)/.exec(rest);
    if (!rel) return fail(`An attribute starts with its relation, after a colon: ${rest}`);
    const relProblem = relationProblem(rel[1]);
    if (relProblem) return fail(relProblem);
    rest = rest.slice(rel[0].length);
    const value = /^("(?:[^"\\]|\\.)*"|[^\s]+)(\s+|$)/.exec(rest);
    if (!value) return fail(`${rel[1]} has no value.`);
    const valueProblem = attrValueProblem(value[1]);
    if (valueProblem) return fail(valueProblem);
    attrs.push({ rel: rel[1], value: value[1] });
    rest = rest.slice(value[0].length);
  }
  return { attrs, problem: null };
};

// The attribute picker's chosen value inside `el`, else its first value:
// where focus goes in it, never a row's clear button, where Enter clears.
export const focusValue = (el) =>
  (
    el?.querySelector('.umr-attr-value[aria-pressed="true"]') ||
    el?.querySelector('.umr-attr-value')
  )?.focus();
