// The closed vocabularies of UMR, as data.
//
// Two inventories are kept apart on purpose. The `schema` sets come from the
// ÚFAL guideline tables (docs/umr/schema/*.json, mirrored in DIGEST.md); the
// `validator` sets are the ones umrtools/validate.py actually enforces
// (validate.py:1224 onwards), and they differ: no `iterative` aspect, no
// `undefined` modal strength, `non-singular` with a hyphen, `4th` person but
// no clusivity, and extra document-level relations the released data uses.
// Checking data against the wrong one produces confident nonsense, so
// validate.js picks a set rather than merging them.

// docs/umr/schema/roles_and_reifications.json, tables 1-3.
export const ROLES = {
  participant: [
    ':actor',
    ':co-actor',
    ':undergoer',
    ':theme',
    ':recipient',
    ':force',
    ':causer',
    ':experiencer',
    ':stimulus',
    ':instrument',
    ':companion',
    ':material',
    ':source',
    ':place',
    ':start',
    ':goal',
    ':affectee',
    ':cause',
    ':manner',
    ':reason',
    ':purpose',
    ':result',
    ':temporal',
    ':extent',
    ':other-role',
  ],
  nonParticipant: [
    ':direction',
    ':path',
    ':quant',
    ':degree',
    ':duration',
    ':frequency',
    ':mod',
    ':topic',
    ':vocative',
    ':medium',
    ':possessor',
    ':part',
    ':group',
    ':age',
    ':example',
    ':ord',
    ':list-item',
  ],
  spatial: [':size', ':color', ':configuration', ':orientation', ':anchor', ':axis'],
  // docs/umr/schema/discourse_relations.json: the relation half of the table.
  discourse: [
    ':apprehensive',
    ':purpose',
    ':manner',
    ':cause',
    ':condition',
    ':temporal',
    ':pure-addition',
    ':substitute',
    ':concession',
    ':concessive-condition',
    ':subtraction',
  ],
};

// publication-91 reaches :ARG11, which is why the range runs this far
// (validate.py:1236).
export const ARG_ROLES = Array.from({ length: 12 }, (_, n) => `:ARG${n}`);

// Reifications of the roles above: `(e :actor x)` said the other way round as
// `(have-actor-91 :ARG1 e :ARG2 x)`.
export const REIFICATIONS = [
  'have-actor-91',
  'have-co-actor-91',
  'have-undergoer-91',
  'have-theme-91',
  'have-recipient-91',
  'have-force-91',
  'have-causer-91',
  'have-experience-91',
  'have-instrument-91',
  'have-companion-91',
  'have-material-91',
  'have-source-91',
  'have-place-91',
  'have-start-91',
  'have-goal-91',
  'have-affectee-91',
  'have-cause-91',
  'have-manner-91',
  'have-reason-91',
  'have-purpose-91',
  'have-result-91',
  'have-temporal-91',
  'have-extent-91',
  'have-other-role-91',
  'have-direction-91',
  'have-path-91',
  'have-quant-91',
  'have-duration-91',
  'have-frequency-91',
  'have-mod-91',
  'have-topic-91',
  'have-vocative-91',
  'have-medium-91',
  'have-poss-91',
  'have-part-91',
  'have-group-91',
  'have-age-91',
  'have-example-91',
  'have-ord-91',
  'have-list-item-91',
  'have-size-91',
  'have-color-91',
  'have-configuration-91',
  'have-orientation-91',
  'have-anchor-91',
  'have-axis-91',
  'have-degree-91',
];

// docs/umr/schema/aspect.json (26 values) against validate.py:1245 (25: no
// `iterative`).
const ASPECT_SCHEMA = [
  'habitual',
  'generic',
  'imperfective',
  'state',
  'reversible-state',
  'irreversible-state',
  'point-state',
  'inherent-state',
  'process',
  'atelic-process',
  'activity',
  'directed-activity',
  'undirected-activity',
  'iterative',
  'perfective',
  'endeavor',
  'semelfactive',
  'undirected-endeavor',
  'directed-endeavor',
  'performance',
  'inceptive',
  'incremental-accomplishment',
  'nonincremental-accomplishment',
  'directed-achievement',
  'reversible-directed-achievement',
  'irreversible-directed-achievement',
];

const MODAL_STRENGTH_SCHEMA = [
  'full-affirmative',
  'partial-affirmative',
  'neutral-affirmative',
  'neutral-negative',
  'partial-negative',
  'full-negative',
  'undefined',
];

/**
 * Attribute value sets. `validator` is what validate.py enforces, `schema`
 * what the guideline tables list. An empty array means any value is allowed.
 */
export const ATTRIBUTES = {
  ':aspect': {
    validator: ASPECT_SCHEMA.filter((value) => value !== 'iterative'),
    schema: ASPECT_SCHEMA,
  },
  ':modal-strength': {
    validator: MODAL_STRENGTH_SCHEMA.filter((value) => value !== 'undefined'),
    schema: MODAL_STRENGTH_SCHEMA,
  },
  ':refer-person': {
    validator: ['1st', '2nd', '3rd', '4th', 'non-1st', 'non-3rd'],
    schema: ['non-1st', 'non-3rd', '1st', '2nd', '3rd', '1st-inclusive', '1st-exclusive'],
  },
  ':refer-number': {
    validator: ['singular', 'non-singular', 'dual', 'trial', 'paucal', 'plural'],
    schema: [
      'singular',
      'nonsingular',
      'paucal',
      'plural',
      'dual',
      'non-dual-paucal',
      'greater-plural',
      'trial',
      'non-trial-paucal',
    ],
  },
  ':refer-definiteness': { validator: ['class'], schema: ['class'] },
  // validate.py leaves these three open; the guidelines do enumerate them, and
  // :polarity and :degree also admit a child node, so validate.js only judges
  // an atomic value against the schema set.
  ':polarity': { validator: [], schema: ['-', '-intense', '+'] },
  ':mode': { validator: [], schema: ['interrogative', 'imperative', 'expressive'] },
  ':polite': { validator: [], schema: ['+', '-'] },
  ':degree': { validator: [], schema: ['intensifier', 'downtoner', 'equal'] },
};

/**
 * Document-level relations by group. The validator's sets are wider because
 * UMR 2.0 English uses `:contains` and `:subset`, and the modal group carries
 * `strong-`/`weak-` variants (validate.py:1742).
 */
export const DOC_RELATIONS = {
  temporal: {
    validator: [':contained', ':contains', ':before', ':after', ':overlap', ':depends-on'],
    schema: [':before', ':after', ':contained', ':overlap', ':depends-on'],
  },
  modal: {
    validator: [
      ':modal',
      ':full-affirmative',
      ':partial-affirmative',
      ':strong-partial-affirmative',
      ':weak-partial-affirmative',
      ':neutral-affirmative',
      ':strong-neutral-affirmative',
      ':weak-neutral-affirmative',
      ':full-negative',
      ':partial-negative',
      ':strong-partial-negative',
      ':weak-partial-negative',
      ':neutral-negative',
      ':strong-neutral-negative',
      ':weak-neutral-negative',
      ':unspecified',
    ],
    schema: [
      ':modal',
      ':full-affirmative',
      ':partial-affirmative',
      ':neutral-affirmative',
      ':neutral-negative',
      ':partial-negative',
      ':full-negative',
    ],
  },
  coref: {
    validator: [':same-entity', ':same-event', ':subset-of', ':contains', ':subset'],
    schema: [':same-entity', ':same-event', ':subset-of'],
  },
};

// The nodes of a document-level relation that are not sentence variables
// (validate.py:1166). `have-condition-91` is there because annotators use it
// as a modal conceiver, documented or not.
export const DOC_CONSTANTS = [
  'root',
  'author',
  'null-conceiver',
  'have-condition-91',
  'document-creation-time',
  'past-reference',
  'present-reference',
  'future-reference',
];

// docs/umr/schema/abstract_concepts.json, its five tables.
export const ABSTRACT_CONCEPTS = {
  implicitHeads: ['person', 'thing', 'animal', 'event', 'place', 'temporal', 'quantity'],
  special: ['umr-unknown', 'truth-value', 'umr-choice', 'umr-empty', 'umr-unintelligible'],
  structuredEntities: [
    'date-entity',
    'string-entity',
    'ordinal-entity',
    'url-entity',
    'percentage-entity',
    'phone-number-entity',
    'email-address-entity',
    'score-entity',
    'date-interval',
    'value-interval',
    'between',
    'slash',
    'emoticon',
    'relative-position',
    'relative-orientation',
    'less-than',
    'more-than',
    'at-least',
    'at-most',
    'sum-of',
    'product-of',
    'ratio-of',
    'difference-of',
    'quotient-of',
    'power-of',
    'root-of',
    'logarithm-of',
  ],
  quantities: [
    'monetary-quantity',
    'distance-quantity',
    'area-quantity',
    'volume-quantity',
    'temporal-quantity',
    'frequency-quantity',
    'speed-quantity',
    'acceleration-quantity',
    'mass-quantity',
    'force-quantity',
    'pressure-quantity',
    'energy-quantity',
    'power-quantity',
    'charge-quantity',
    'potential-quantity',
    'resistance-quantity',
    'inductance-quantity',
    'magnetic-field-quantity',
    'magnetic-flux-quantity',
    'radiation-quantity',
    'fuel-consumption-quantity',
    'numerical-quantity',
    'information-quantity',
    'concentration-quantity',
    'catalytic-activity-quantity',
    'acidity-quantity',
    'seismic-quantity',
    'temperature-quantity',
  ],
  spatial: [
    'cartesian-coordinate-entity',
    'dimension-entity',
    'slope-quantity',
    'composite-entity',
    'space',
    'trajectory',
  ],
  // The subroles of date-entity, kept because the Info panels list them.
  dateSubroles: [
    ':calendar',
    ':century',
    ':day',
    ':dayperiod',
    ':decade',
    ':era',
    ':month',
    ':quarter',
    ':season',
    ':time',
    ':timezone',
    ':weekday',
    ':year',
    ':year2',
  ],
};

// docs/umr/schema/abstract_91_rolesets.json and
// nonprototypical_predication.json. In text one of these is an ordinary node
// with :ARGn children.
export const ROLESETS_91 = [
  'byline-91',
  'confirm-91',
  'correlate-91',
  'course-91',
  'distribution-range-91',
  'emit-sound-91',
  'gesture-91',
  'hyperlink-91',
  'in-text-reference-91',
  'include-91',
  'infer-91',
  'mean-91',
  'proverb-91',
  'publication-91',
  'range-91',
  'rate-entity-91',
  'request-confirmation-91',
  'request-response-91',
  'resemble-91',
  'say-91',
  'score-on-scale-91',
  'statistical-test-91',
  'street-address-91',
  'weather-91',
  'cartesian-framework-91',
  'have-possession-91',
  'thetic-possession-91',
  'pred-possession-91',
  'exist-91',
  'have-place-91',
  'thetic-location-91',
  'pred-location-91',
  'have-mod-91',
  'identity-91',
  'have-role-91',
  'have-rel-role-92',
  'have-org-role-92',
];

// docs/umr/schema/discourse_relations.json: the concept half of the table,
// widened by validate.py:1396, which also lists the AMR spellings and the
// reifications the released data uses.
export const DISCOURSE_CONCEPTS = {
  schema: [
    'or',
    'exclusive-disj',
    'inclusive-disj',
    'and-but',
    'and',
    'consecutive',
    'additive',
    'and-unexpected',
    'unexpected-co-occurence-91',
    'and-contrast',
    'contrast-91',
  ],
  validator: [
    'multi-sentence',
    'and',
    'or',
    'inclusive-disjunction',
    'exclusive-disjunction',
    'and-but',
    'consecutive',
    'additive',
    'and-unexpected',
    'and-contrast',
    'but-91',
    'unexpected-co-occurrence-91',
    'contrast-91',
    'have-apprehensive-91',
    'have-condition-91',
    'have-pure-addition-91',
    'have-substitution-91',
    'have-concession-91',
    'have-concessive-condition-91',
    'have-subtraction-91',
  ],
};

// Rolesets that look like events (they have :ARGn children) but are structured
// metadata, so they must not carry :aspect (validate.py:1408).
export const NON_EVENT_ROLESETS = [
  'byline-91',
  'cite-91',
  'course-91',
  'distribution-range-91',
  'emit-sound-91',
  'hyperlink-91',
  'mean-91',
  'proverb-91',
  'publication-91',
  'range-91',
  'rate-entity-91',
  'reference-illustration-91',
  'score-on-scale-91',
  'statistical-test-91',
  'street-address-91',
  'weather-91',
];

/**
 * The concepts validate.py exempts from needing :aspect and a document-level
 * :temporal relation: the discourse connectives and the non-event rolesets.
 */
export const EVENT_EXEMPT = [...DISCOURSE_CONCEPTS.validator, ...NON_EVENT_ROLESETS];

// docs/umr/schema/named_entities.json: 212 nodes under `thing`, as the
// parent-to-children map the tree is built from.
const NAMED_ENTITY_CHILDREN = {
  thing: [
    'person',
    'animal',
    'plant',
    'language',
    'nationality',
    'implicit-argument',
    'social-group',
    'organization',
    'natural-object',
    'place',
    'historical-period',
    'event',
    'cultural-activity',
    'cultural-artifact',
    'vehicle-type',
    'qualification',
    'government-output',
    'system',
    'biomedical-entity',
    'category',
    'conceptualization',
    'movement',
    'financial-entity',
    'name',
  ],
  person: ['individual-person'],
  'social-group': [
    'family',
    'clan',
    'ethnic-group',
    'regional-group',
    'religious-group',
    'performing-group',
  ],
  organization: [
    'company',
    'association',
    'business',
    'market-sector',
    'government-organization',
    'international-organization',
    'political-organization',
    'religious-organization',
    'criminal-organization',
    'armed-organization',
    'academic-organization',
    'sports-organization',
  ],
  'natural-object': ['rock', 'celestial-entity'],
  'celestial-entity': [
    'galaxy',
    'solar-system',
    'star',
    'planet',
    'moon',
    'small-celestial-body',
    'constellation',
  ],
  place: ['geographical-entity', 'region', 'geo-political-entity', 'facility'],
  'geographical-entity': ['water-entity', 'land-entity', 'ecosystem'],
  'water-entity': ['ocean', 'sea', 'lake', 'river', 'gulf', 'bay', 'strait'],
  'land-entity': [
    'continent',
    'island',
    'peninsula',
    'mountain',
    'mountain-range',
    'pass',
    'volcano',
    'glaciological-entity',
    'valley',
    'canyon',
  ],
  ecosystem: ['desert', 'forest', 'wetland', 'grassland', 'coastland'],
  region: ['world-region', 'country-region', 'local-region'],
  'geo-political-entity': [
    'country',
    'country-partition',
    'nation',
    'human-settlement',
    'protected-area',
  ],
  'protected-area': ['nature-reserve', 'culturally-protected-area'],
  facility: ['animal-nest', 'station', 'thoroughfare', 'utility-structure', 'cultural-facility'],
  station: ['airport', 'port', 'spaceport'],
  thoroughfare: ['tunnel', 'bridge', 'road', 'railway-line'],
  'utility-structure': ['canal', 'dam'],
  'cultural-facility': [
    'building',
    'room',
    'theater',
    'museum',
    'palace',
    'hotel',
    'worship-place',
    'sports-facility',
    'market',
    'park',
    'city-square',
  ],
  event: ['assembly', 'incident', 'war', 'mission', 'natural-disaster'],
  'natural-disaster': [
    'earthquake',
    'cyclone',
    'flood',
    'landslide',
    'avalanche',
    'volcanic-disaster',
    'duststorm',
    'fire',
  ],
  'cultural-activity': ['game', 'festival', 'ceremony', 'performance'],
  performance: ['dance'],
  'cultural-artifact': [
    'product',
    'weapon-type',
    'weapon',
    'food-dish',
    'music',
    'work-of-art',
    'body-of-literature',
    'publication',
    'broadcast-program',
    'broadcast-network',
    'news-media',
    'website',
    'cyber-entity',
  ],
  publication: ['book', 'magazine', 'journal'],
  'cyber-entity': ['computer-program', 'social-media', 'cyber-attack'],
  'vehicle-type': [
    'vehicle',
    'automobile',
    'automobile-type',
    'ship',
    'ship-type',
    'aircraft',
    'aircraft-type',
    'spacecraft',
    'spacecraft-type',
  ],
  qualification: ['degree', 'test', 'honor'],
  'government-output': ['policy', 'legislation'],
  legislation: ['court-decision', 'treaty', 'tax', 'social-program'],
  system: ['identification-number', 'notational-system', 'currency-system', 'measurement-system'],
  'notational-system': ['color', 'music-key', 'musical-note', 'writing-script', 'variable'],
  'measurement-system': ['unit'],
  'biomedical-entity': [
    'molecular-physical-entity',
    'chemical-compound',
    'small-molecule',
    'protein',
    'protein-family',
    'protein-segment',
    'amino-acid',
    'macro-molecular-complex',
    'enzyme',
    'nucleic-acid',
    'pathway',
    'gene',
    'dna-sequence',
    'cell',
    'cell-line',
    'pathogen',
    'disease',
    'medical-condition',
    'behavior',
    'medicinal-substance',
    'diet',
    'therapy',
  ],
  category: ['taxon'],
  taxon: ['species', 'breed'],
  conceptualization: ['religion', 'political-ideology'],
  movement: ['religious-movement', 'social-movement', 'arts-movement'],
};

const buildTree = (name) => ({
  name,
  children: (NAMED_ENTITY_CHILDREN[name] ?? []).map(buildTree),
});

/** The named entity type hierarchy, rooted at `thing`. */
export const NAMED_ENTITY_TREE = buildTree('thing');

/** Every named entity type, `thing` included, in tree order. */
export const NAMED_ENTITY_TYPES = (function flatten(node, into = []) {
  into.push(node.name);
  node.children.forEach((child) => flatten(child, into));
  return into;
})(NAMED_ENTITY_TREE);

/**
 * Every relation validate.py knows, with the type it expects on the right and
 * whether one parent may carry it more than once (validate.py:1224). An
 * `values` array, where present, is the validator's set for that attribute.
 */
export const KNOWN_RELATIONS = (() => {
  const relations = {};
  const add = (names, type, repeat, values) => {
    names.forEach((name) => {
      relations[name] = values ? { type, repeat, values } : { type, repeat };
    });
  };
  // Participants: one per parent.
  add(ARG_ROLES, 'participant', false);
  add(
    [
      ':actor',
      ':affectee',
      ':beneficiary',
      ':causer',
      ':co-actor',
      ':companion',
      ':experiencer',
      ':force',
      ':goal',
      ':instrument',
      ':material',
      ':recipient',
      ':source',
      ':start',
      ':theme',
      ':undergoer',
    ],
    'participant',
    false,
  );
  add([':stimulus', ':place'], 'participant', true);
  // Modifiers that may not repeat under one parent.
  add(
    [
      ':age',
      ':apprehensive',
      ':calendar',
      ':domain',
      ':group',
      ':li',
      ':medium',
      ':modal-predicate',
      ':name',
      ':ord',
      ':range',
      ':scale',
      ':season',
      ':subevent',
      ':substitute',
      ':subtraction',
      ':timezone',
      ':unit',
      ':vocative',
      ':weekday',
      ':according-to',
      ':comparison',
      ':part-of-phraseme',
      ':predicative-noun',
    ],
    'modifier',
    false,
  );
  // Modifiers that may repeat.
  add(
    [
      ':anchor',
      ':axis',
      ':cause',
      ':color',
      ':concession',
      ':concessive-condition',
      ':condition',
      ':configuration',
      ':destination',
      ':direction',
      ':duration',
      ':example',
      ':extent',
      ':manner',
      ':orientation',
      ':other-role',
      ':part',
      ':path',
      ':possessor',
      ':pure-addition',
      ':purpose',
      ':quote',
      ':reason',
      ':result',
      ':size',
      ':temporal',
      ':topic',
      ':clausal-marker',
      ':contrast',
      ':effect',
      ':interjection',
      ':parenthesis',
      ':regard',
      ':range-start',
      ':range-trajectory',
      ':rise-axis',
      ':run-axis',
      ':FR',
      ':framework',
      ':concessive-conditional',
      ':consist',
      ':conj-as-if',
      ':ordinal-entity',
      ':content',
      ':snt1',
      ':snt2',
      ':sentence1',
      ':sentence2',
      ':sentence3',
      ':scope',
      ':ratio',
      ':level',
      ':conceiver',
      ':subset',
      ':compared-to',
      ':perspective',
    ],
    'modifier',
    true,
  );
  add(
    [
      ':prep-against',
      ':prep-as',
      ':prep-by',
      ':prep-for',
      ':prep-from',
      ':prep-in',
      ':prep-on',
      ':prep-on-behalf',
      ':prep-to',
      ':prep-under',
      ':prep-with',
      ':prep-without',
    ],
    'modifier',
    true,
  );
  // Attributes: an atomic, numeric or string value rather than a child node.
  add(
    [
      ':century',
      ':day',
      ':dayperiod',
      ':decade',
      ':era',
      ':mode',
      ':month',
      ':op1',
      ':polarity',
      ':polite',
      ':quarter',
      ':value',
      ':wiki',
      ':year',
      ':year2',
      ':end-state',
      ':list-item',
    ],
    'attribute',
    false,
  );
  add([':degree', ':frequency', ':mod', ':quant', ':time', ':x', ':y', ':z'], 'attribute', true);
  add([':lat', ':long', ':smood'], 'attribute', true);
  add([':aspect'], 'attribute', false, ATTRIBUTES[':aspect'].validator);
  add([':modal-strength'], 'attribute', false, ATTRIBUTES[':modal-strength'].validator);
  add([':refer-person'], 'attribute', false, ATTRIBUTES[':refer-person'].validator);
  add([':refer-number'], 'attribute', false, ATTRIBUTES[':refer-number'].validator);
  add([':refer-definiteness'], 'attribute', false, ATTRIBUTES[':refer-definiteness'].validator);
  return relations;
})();

/**
 * Whether a relation is the `-of` inverse of another. The suffix is the whole
 * test, as it is in validate.py:1432; a base role that happens to end in
 * `-of` would be indistinguishable, which is why `:consist` rather than
 * `:consist-of` is the one in KNOWN_RELATIONS.
 */
export function isInverse(role) {
  return typeof role === 'string' && role.startsWith(':') && role.endsWith('-of');
}

/** The other way round: `:ARG0` to `:ARG0-of` and back. */
export function inverseOf(role) {
  if (typeof role !== 'string' || !role.startsWith(':')) return role;
  return role.endsWith('-of') ? role.slice(0, -3) : `${role}-of`;
}
