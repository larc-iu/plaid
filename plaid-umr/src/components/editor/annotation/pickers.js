// What the canvas's editors offer: roles for a relation, concepts for a node,
// attribute lines for a node. The lexicon (frame files, the project
// vocabulary) joins the concept options in a later phase.
import {
  ARG_ROLES,
  ROLES,
  ABSTRACT_CONCEPTS,
  ROLESETS_91,
  DISCOURSE_CONCEPTS,
  ATTRIBUTES,
} from '../../../domain/format/inventory.js';
import { sensesFor, rolesetsStartingWith, argsOf, argSummary } from '../../../domain/lexicon.js';

const flat = (v) => (Array.isArray(v) ? v : Object.values(v || {}).flat());

const uniq = (list) => [...new Set(list.filter(Boolean))];

// Roles for an edge out of `parentConcept`: the parent's own arguments
// first, with what each means, when the frame file knows the roleset.
export const roleOptions = (frames = null, parentConcept = null) => [
  ...(parentConcept && argsOf(frames, parentConcept).length
    ? [
        {
          group: parentConcept,
          items: argsOf(frames, parentConcept).map((a) => ({
            value: a.role,
            label: `${a.role} ${a.description}`,
          })),
        },
      ]
    : []),
  { group: 'Core', items: ARG_ROLES },
  { group: 'Participant', items: flat(ROLES.participant) },
  { group: 'Non-participant', items: flat(ROLES.nonParticipant) },
  { group: 'Spatial', items: flat(ROLES.spatial) },
  { group: 'Discourse', items: flat(ROLES.discourse) },
];

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
export const conceptOptions = (words = [], frames = null, typed = '') => {
  const senses = uniq(words.flatMap((w) => sensesFor(frames, w.text).map((x) => x.id)));
  const byPrefix = typed && !words.length ? rolesetsStartingWith(frames, typed) : [];
  const senseItem = (id) => ({ value: id, label: `${id} ${argSummary(frames?.[id])}` });
  const surface = uniq(words.map((w) => w.text));
  const abstract = uniq(flat(ABSTRACT_CONCEPTS).map((c) => (typeof c === 'string' ? c : c.name)));
  const rolesets = uniq(flat(ROLESETS_91).map((c) => (typeof c === 'string' ? c : c.name)));
  const discourse = uniq(
    flat(DISCOURSE_CONCEPTS.validator || DISCOURSE_CONCEPTS).map((c) =>
      typeof c === 'string' ? c : c.name,
    ),
  );
  return [
    ...(senses.length ? [{ group: 'Senses', items: senses.map(senseItem) }] : []),
    ...(byPrefix.length
      ? [{ group: 'Rolesets', items: byPrefix.map((x) => senseItem(x.id)) }]
      : []),
    ...(surface.length ? [{ group: 'Word', items: surface }] : []),
    { group: 'Abstract', items: abstract },
    { group: 'Rolesets', items: rolesets },
    { group: 'Discourse', items: discourse },
  ];
};

// Words of a sentence as options for a new node: the label shows the index.
export const wordOptions = (words = []) =>
  words.map((w) => ({ value: `${w.index}`, label: `${w.index} ${w.text}`, word: w }));

// Attribute lines: `:aspect performance`, offered as whole lines from the
// active value sets, so typing `asp` lists every aspect value.
export const attributeLineOptions = (sets = 'validator') => {
  const groups = [];
  Object.entries(ATTRIBUTES || {}).forEach(([rel, byset]) => {
    const values = byset?.[sets] || byset?.validator || [];
    if (!values.length) return;
    const name = rel.startsWith(':') ? rel : `:${rel}`;
    groups.push({ group: name, items: values.map((v) => `${name} ${v}`) });
  });
  return groups;
};

// One line of attributes to and from a node's `attrs`. A string value keeps
// its quotes, which is what the raw PENMAN token carries.
export const attrsToLine = (attrs) => attrs.map((a) => `${a.rel} ${a.value}`).join(' ');

export const lineToAttrs = (line) => {
  const attrs = [];
  const re = /(:[^\s]+)\s+("(?:[^"\\]|\\.)*"|[^\s:][^\s]*)/g;
  let m;
  while ((m = re.exec(line))) attrs.push({ rel: m[1], value: m[2] });
  return attrs;
};
