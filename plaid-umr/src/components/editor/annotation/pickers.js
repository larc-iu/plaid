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
  isInverse,
} from '../../../domain/format/inventory.js';

const flat = (v) => (Array.isArray(v) ? v : Object.values(v || {}).flat());

const uniq = (list) => [...new Set(list.filter(Boolean))];

export const roleOptions = () => [
  { group: 'Core', items: ARG_ROLES },
  { group: 'Participant', items: flat(ROLES.participant) },
  { group: 'Non-participant', items: flat(ROLES.nonParticipant) },
  { group: 'Spatial', items: flat(ROLES.spatial) },
  { group: 'Discourse', items: flat(ROLES.discourse) },
];

// A role typed with `-of` is the inverse of a listed one, and a role typed
// without its colon gets one.
export const normalizeRole = (text) => {
  const t = String(text || '').trim();
  if (!t) return '';
  const withColon = t.startsWith(':') ? t : `:${t}`;
  void isInverse;
  return withColon;
};

// Concepts for a node anchored to `words` (their surface forms first), then
// the abstract inventory.
export const conceptOptions = (words = []) => {
  const surface = uniq(words.map((w) => w.text));
  const abstract = uniq(flat(ABSTRACT_CONCEPTS).map((c) => (typeof c === 'string' ? c : c.name)));
  const rolesets = uniq(flat(ROLESETS_91).map((c) => (typeof c === 'string' ? c : c.name)));
  const discourse = uniq(
    flat(DISCOURSE_CONCEPTS.validator || DISCOURSE_CONCEPTS).map((c) =>
      typeof c === 'string' ? c : c.name,
    ),
  );
  return [
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
