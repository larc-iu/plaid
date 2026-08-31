import { describe, it, expect } from 'vitest';
import { readEaf, baseTierName, chainOrder, EafError } from './readEaf.js';
import {
  tierSchema,
  signatureOf,
  compareSchemas,
  suggestRoles,
  validateRoles,
  nodeLabel,
  ROLES,
} from './schema.js';
import { buildElanDocuments, readMorphForm, alignSegments } from './buildDocuments.js';
import { buildEafDocument } from '../../export/elan.js';

// ---- fixtures --------------------------------------------------------------

// A compact .eaf writer, so a fixture reads as its tier structure rather than
// as 60 lines of XML. `tiers` is [{id, type, parent, participant, anns}] where
// an ann is [id, value, ref|null, previous|null] or [id, value, beginMs, endMs].
function eafXml({ tiers, types, properties = {}, media = null }) {
  const slots = [];
  const body = tiers
    .map((t) => {
      const anns = t.anns
        .map((a) => {
          if (typeof a[2] === 'number' || a[2] === null_ms) {
            const [id, value, beginMs, endMs] = a;
            const s1 = `ts${slots.length + 1}`;
            slots.push([s1, beginMs]);
            const s2 = `ts${slots.length + 1}`;
            slots.push([s2, endMs]);
            return `<ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="${id}" TIME_SLOT_REF1="${s1}" TIME_SLOT_REF2="${s2}"><ANNOTATION_VALUE>${value}</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>`;
          }
          const [id, value, ref, previous] = a;
          const prev = previous ? ` PREVIOUS_ANNOTATION="${previous}"` : '';
          return `<ANNOTATION><REF_ANNOTATION ANNOTATION_ID="${id}" ANNOTATION_REF="${ref}"${prev}><ANNOTATION_VALUE>${value}</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>`;
        })
        .join('');
      const parent = t.parent ? ` PARENT_REF="${t.parent}"` : '';
      const who = t.participant ? ` PARTICIPANT="${t.participant}"` : '';
      return `<TIER TIER_ID="${t.id}" LINGUISTIC_TYPE_REF="${t.type}"${parent}${who}>${anns}</TIER>`;
    })
    .join('');
  const typeXml = Object.entries(types)
    .map(
      ([id, constraint]) =>
        `<LINGUISTIC_TYPE LINGUISTIC_TYPE_ID="${id}" TIME_ALIGNABLE="${constraint === null || constraint === 'Included_In' || constraint === 'Time_Subdivision'}"${constraint ? ` CONSTRAINTS="${constraint}"` : ''}/>`,
    )
    .join('');
  const props = Object.entries(properties)
    .map(([k, v]) => `<PROPERTY NAME="${k}">${v}</PROPERTY>`)
    .join('');
  const mediaXml = media
    ? `<MEDIA_DESCRIPTOR MEDIA_URL="${media}" RELATIVE_MEDIA_URL="./${media}" MIME_TYPE="audio/x-wav"/>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<ANNOTATION_DOCUMENT AUTHOR="t" DATE="2026-01-01T00:00:00Z" VERSION="2.8" FORMAT="2.8">
<HEADER TIME_UNITS="milliseconds">${mediaXml}${props}</HEADER>
<TIME_ORDER>${slots.map(([id, v]) => `<TIME_SLOT TIME_SLOT_ID="${id}"${v === null ? '' : ` TIME_VALUE="${v}"`}/>`).join('')}</TIME_ORDER>
${body}${typeXml}
</ANNOTATION_DOCUMENT>`;
}
// Sentinel so an unaligned annotation is still recognised as alignable.
const null_ms = null;

// The Toolbox/Shoebox shape that dominates real ELAN documentation corpora:
// a speaker-named top tier, words under it, morphemes under those, glosses
// under those, and a free translation on the utterance.
const toolboxFile = (speaker, utterances) =>
  eafXml({
    types: {
      utterance: null,
      wd: 'Symbolic_Subdivision',
      mb: 'Symbolic_Subdivision',
      ge: 'Symbolic_Association',
      ft: 'Symbolic_Association',
    },
    properties: {},
    tiers: [
      {
        id: speaker,
        type: 'utterance',
        participant: speaker,
        anns: utterances.map((u) => [u.id, u.text, u.begin, u.end]),
      },
      {
        id: `wd@${speaker}`,
        type: 'wd',
        parent: speaker,
        participant: speaker,
        anns: utterances.flatMap((u) => u.words.map((w) => [w.id, w.form, u.id, w.previous])),
      },
      {
        id: `mb@${speaker}`,
        type: 'mb',
        parent: `wd@${speaker}`,
        participant: speaker,
        anns: utterances.flatMap((u) =>
          u.words.flatMap((w) => (w.morphs || []).map((m) => [m.id, m.form, w.id, m.previous])),
        ),
      },
      {
        id: `ge@${speaker}`,
        type: 'ge',
        parent: `mb@${speaker}`,
        participant: speaker,
        anns: utterances.flatMap((u) =>
          u.words.flatMap((w) =>
            (w.morphs || []).filter((m) => m.gloss).map((m) => [`g-${m.id}`, m.gloss, m.id, null]),
          ),
        ),
      },
      {
        id: `ft@${speaker}`,
        type: 'ft',
        parent: speaker,
        participant: speaker,
        anns: utterances.filter((u) => u.free).map((u) => [`f-${u.id}`, u.free, u.id, null]),
      },
    ],
  });

const ANA = toolboxFile('Ana', [
  {
    id: 'a1',
    text: 'los perros corren',
    begin: 500,
    end: 2250,
    free: 'the dogs run',
    words: [
      { id: 'w1', form: 'los', morphs: [{ id: 'm1', form: 'los', gloss: 'DET' }] },
      {
        id: 'w2',
        form: 'perros',
        previous: 'w1',
        morphs: [
          { id: 'm2', form: 'perro', gloss: 'dog' },
          { id: 'm3', form: '-s', gloss: 'PL', previous: 'm2' },
        ],
      },
      {
        id: 'w3',
        form: 'corren',
        previous: 'w2',
        morphs: [{ id: 'm4', form: 'corren', gloss: 'run' }],
      },
    ],
  },
]);

// ---- readEaf ---------------------------------------------------------------

describe('readEaf', () => {
  it('reads tiers, annotations, times and properties', () => {
    const eaf = readEaf(ANA, 'ana.eaf');
    expect(eaf.tiers).toHaveLength(5);
    const top = eaf.tiers[0];
    expect(top.id).toBe('Ana');
    expect(top.participant).toBe('Ana');
    expect(top.annotations[0]).toMatchObject({
      id: 'a1',
      kind: 'alignable',
      value: 'los perros corren',
      beginMs: 500,
      endMs: 2250,
    });
    const words = eaf.tiers[1];
    expect(words.annotations.map((a) => a.value)).toEqual(['los', 'perros', 'corren']);
    expect(words.annotations[1]).toMatchObject({ kind: 'ref', ref: 'a1', previous: 'w1' });
  });

  it('normalizes the participant out of a tier name', () => {
    expect(baseTierName('mb@Ana', 'Ana')).toBe('mb');
    expect(baseTierName('Ana', 'Ana')).toBe(''); // speaker-named top tier
    expect(baseTierName('ref', '')).toBe('ref');
    expect(baseTierName('gloss@Bo', '')).toBe('gloss'); // no PARTICIPANT attribute
  });

  it('leaves an annotation on a value-less time slot untimed', () => {
    const xml = eafXml({
      types: { u: null },
      tiers: [{ id: 'T', type: 'u', anns: [['a1', 'no time', null_ms, null_ms]] }],
    });
    const ann = readEaf(xml, 'x.eaf').tiers[0].annotations[0];
    expect(ann.beginMs).toBeNull();
    expect(ann.endMs).toBeNull();
    expect(ann.value).toBe('no time');
  });

  it('takes the document name from our own exporter, else the filename', () => {
    expect(readEaf(ANA, 'some/path/Ana Story.eaf').documentName).toBe('Ana Story');
    const named = eafXml({
      types: { u: null },
      tiers: [{ id: 'T', type: 'u', anns: [] }],
      properties: { documentName: 'Real Name' },
    });
    expect(readEaf(named, 'x.eaf').documentName).toBe('Real Name');
  });

  it('rejects a file that is not EAF', () => {
    expect(() => readEaf('<html><body>no</body></html>', 'x.eaf')).toThrow(EafError);
    expect(() => readEaf('<ANNOTATION_DOCUMENT><TIER>', 'x.eaf')).toThrow(EafError);
  });

  it('chainOrder follows PREVIOUS_ANNOTATION and falls back to document order', () => {
    const anns = [
      { id: 'c', previous: 'b' },
      { id: 'a', previous: null },
      { id: 'b', previous: 'a' },
    ];
    expect(chainOrder(anns).map((a) => a.id)).toEqual(['a', 'b', 'c']);
    // A broken chain (two heads) is left as it was rather than half-sorted.
    const broken = [
      { id: 'x', previous: null },
      { id: 'y', previous: null },
    ];
    expect(chainOrder(broken).map((a) => a.id)).toEqual(['x', 'y']);
  });
});

// ---- schema ----------------------------------------------------------------

describe('tier schema', () => {
  it('collapses participants into one node per tier position', () => {
    const eaf = readEaf(ANA, 'ana.eaf');
    const nodes = tierSchema(eaf);
    expect(nodes.map(nodeLabel).sort()).toEqual(['(speaker tier)', 'ft', 'ge', 'mb', 'wd']);
    const wd = nodes.find((n) => n.baseName === 'wd');
    expect(wd.stereotype).toBe('Symbolic_Subdivision');
    expect(wd.participants).toEqual(['Ana']);
    expect(wd.annotationCount).toBe(3);
  });

  it('matches two files whose only difference is the speaker', () => {
    const bo = toolboxFile('Bo', [
      { id: 'b1', text: 'tres gatos', begin: 0, end: 900, words: [{ id: 'v1', form: 'tres' }] },
    ]);
    const a = signatureOf(tierSchema(readEaf(ANA, 'a.eaf')));
    const b = signatureOf(tierSchema(readEaf(bo, 'b.eaf')));
    expect(a).toBe(b);
    expect(compareSchemas([readEaf(ANA, 'a.eaf'), readEaf(bo, 'b.eaf')]).consistent).toBe(true);
  });

  it('refuses a batch whose files disagree, naming the difference', () => {
    const noGloss = eafXml({
      types: { utterance: null, wd: 'Symbolic_Subdivision' },
      tiers: [
        { id: 'Cy', type: 'utterance', participant: 'Cy', anns: [['c1', 'hola', 0, 100]] },
        {
          id: 'wd@Cy',
          type: 'wd',
          parent: 'Cy',
          participant: 'Cy',
          anns: [['x1', 'hola', 'c1', null]],
        },
      ],
    });
    const result = compareSchemas([
      readEaf(ANA, 'a.eaf'),
      readEaf(ANA, 'a2.eaf'),
      readEaf(noGloss, 'odd.eaf'),
    ]);
    expect(result.consistent).toBe(false);
    expect(result.groups).toHaveLength(2);
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0].files).toEqual(['odd.eaf']);
    expect(result.differences[0].missing.sort()).toEqual(['ft', 'ge', 'mb']);
    expect(result.differences[0].extra).toEqual([]);
  });

  it('suggests roles from the tier tree', () => {
    const nodes = tierSchema(readEaf(ANA, 'a.eaf'));
    const roles = suggestRoles(nodes);
    const roleOf = (name) => roles[nodes.find((n) => n.baseName === name).key];
    expect(roles[nodes.find((n) => n.baseName === '').key]).toBe(ROLES.UTTERANCE);
    expect(roleOf('wd')).toBe(ROLES.WORD);
    expect(roleOf('mb')).toBe(ROLES.MORPHEME);
    expect(roleOf('ge')).toBe(ROLES.MORPH_FIELD);
    expect(roleOf('ft')).toBe(ROLES.SENTENCE_FIELD);
    expect(validateRoles(nodes, roles)).toEqual([]);
  });

  // Found by running real corpora through the pipeline: the Poio sample's word
  // tier is a Time_Subdivision, and treating only Symbolic_Subdivision as words
  // collapsed the whole interlinear hierarchy beneath it to "off".
  it('takes a Time_Subdivision tier as the words, not as time alignment', () => {
    const xml = eafXml({
      types: { u: null, wd: 'Time_Subdivision', ps: 'Symbolic_Association' },
      tiers: [
        { id: 'T', type: 'u', anns: [['a1', 'los perros', 0, 1000]] },
        {
          id: 'W-Words',
          type: 'wd',
          parent: 'T',
          anns: [
            ['w1', 'los', 0, 400],
            ['w2', 'perros', 400, 1000],
          ],
        },
        {
          id: 'W-POS',
          type: 'ps',
          parent: 'W-Words',
          anns: [
            ['p1', 'DET', 'w1', null],
            ['p2', 'NOUN', 'w2', null],
          ],
        },
      ],
    });
    const parsed = [readEaf(xml, 'x.eaf')];
    const { nodes } = compareSchemas(parsed);
    const roles = suggestRoles(nodes);
    const roleOf = (name) => roles[nodes.find((n) => n.baseName === name).key];
    expect(roleOf('W-Words')).toBe(ROLES.WORD);
    expect(roleOf('W-POS')).toBe(ROLES.WORD_FIELD);

    // Time_Subdivision children are ALIGNABLE annotations with no
    // ANNOTATION_REF, so they are found by time containment, not by reference.
    const doc = buildElanDocuments(parsed, nodes, roles).documents[0];
    expect(doc.words.map((w) => doc.body.slice(w.begin, w.end))).toEqual(['los', 'perros']);
    expect(doc.words.map((w) => w.fields['W-POS'])).toEqual(['DET', 'NOUN']);
  });

  // Also from real data: the Abui sample's tiers all hold one annotation, so the
  // annotation count says nothing and picking alphabetically chose `gloss`.
  it('prefers a transcription-shaped name when root tiers tie', () => {
    const xml = eafXml({
      types: { a: null },
      tiers: [
        { id: 'gloss', type: 'a', anns: [['g1', 'add gloss here', 0, 500]] },
        { id: 'transcription', type: 'a', anns: [['t1', 'real text here', 0, 500]] },
      ],
    });
    const parsed = [readEaf(xml, 'x.eaf')];
    const { nodes } = compareSchemas(parsed);
    const roles = suggestRoles(nodes);
    expect(roles[nodes.find((n) => n.baseName === 'transcription').key]).toBe(ROLES.UTTERANCE);
    expect(roles[nodes.find((n) => n.baseName === 'gloss').key]).not.toBe(ROLES.UTTERANCE);
  });

  it('reports an unusable mapping', () => {
    const nodes = tierSchema(readEaf(ANA, 'a.eaf'));
    const roles = suggestRoles(nodes);
    const none = Object.fromEntries(Object.keys(roles).map((k) => [k, ROLES.OFF]));
    expect(validateRoles(nodes, none)[0]).toMatch(/which tier holds the utterances/);

    const wdKey = nodes.find((n) => n.baseName === 'wd').key;
    const orphanMorphemes = { ...roles, [wdKey]: ROLES.OFF };
    expect(validateRoles(nodes, orphanMorphemes)).toContain(
      'A morpheme tier needs a word tier above it.',
    );
  });
});

// ---- buildDocuments --------------------------------------------------------

const buildFrom = (files, overrides = {}) => {
  const parsed = files.map(([xml, name]) => readEaf(xml, name));
  const { nodes } = compareSchemas(parsed);
  const roles = { ...suggestRoles(nodes), ...overrides };
  const build = buildElanDocuments(parsed, nodes, roles);
  // Every fixture, not just the one written for it, has to satisfy the
  // partition invariant the server enforces.
  build.documents.forEach(expectSentencesTile);
  return { build, nodes, roles };
};

// The sentence layer is `partitioning`, so the server rejects any bulk call
// whose sentence tokens do not tile [0, len) exactly. The engine tests run
// against a stub client that cannot enforce that, so it is asserted here on the
// model instead. A real .eaf with several utterances broke on a live server
// because each sentence stopped short of the newline joining it to the next.
const expectSentencesTile = (doc) => {
  const len = [...doc.body].length;
  if (!len) return;
  let at = 0;
  for (const s of doc.sentences) {
    expect(s.begin).toBe(at);
    expect(s.end).toBeGreaterThanOrEqual(s.begin);
    at = s.end;
  }
  expect(at).toBe(len);
};

describe('buildElanDocuments', () => {
  it('synthesizes a baseline and re-derives every offset', () => {
    const { build } = buildFrom([[ANA, 'ana.eaf']]);
    const doc = build.documents[0];
    expect(doc.body).toBe('los perros corren');
    expect(doc.sentences).toEqual([{ begin: 0, end: 17, fields: { ft: 'the dogs run' } }]);
    expect(doc.words.map((w) => [w.begin, w.end])).toEqual([
      [0, 3],
      [4, 10],
      [11, 17],
    ]);
    expect(doc.words[1].morphemes.map((m) => [m.form, m.fields.ge])).toEqual([
      ['perro', 'dog'],
      ['s', 'PL'],
    ]);
    expect(doc.alignments).toEqual([
      { begin: 0, end: 17, timeBegin: 0.5, timeEnd: 2.25, speaker: 'Ana' },
    ]);
  });

  it('tiles the body with sentences, absorbing the joining newlines', () => {
    const three = toolboxFile('Ana', [
      { id: 'a1', text: 'uno', begin: 0, end: 1000, words: [{ id: 'w1', form: 'uno' }] },
      { id: 'a2', text: 'dos tres', begin: 1000, end: 2000, words: [{ id: 'w2', form: 'dos' }] },
      { id: 'a3', text: 'cuatro', begin: 2000, end: 3000, words: [{ id: 'w3', form: 'cuatro' }] },
    ]);
    const { build } = buildFrom([[three, 'three.eaf']]);
    const doc = build.documents[0];
    expect(doc.body).toBe('uno\ndos tres\ncuatro');
    // Each sentence runs up to the start of the next, so the newline belongs to
    // the sentence before it and there is no gap anywhere.
    expect(doc.sentences.map((s) => [s.begin, s.end])).toEqual([
      [0, 4],
      [4, 13],
      [13, 19],
    ]);
    expectSentencesTile(doc);
    // Words still sit on the text itself, never on a joining newline.
    expect(doc.words.map((w) => doc.body.slice(w.begin, w.end))).toEqual(['uno', 'dos', 'cuatro']);
  });

  it('interleaves speakers by start time across one file', () => {
    // Two top tiers, one per speaker, whose utterances alternate in time.
    const xml = eafXml({
      types: { u: null },
      tiers: [
        {
          id: 'Ana',
          type: 'u',
          participant: 'Ana',
          anns: [
            ['a1', 'primero', 0, 1000],
            ['a2', 'tercero', 4000, 5000],
          ],
        },
        { id: 'Bo', type: 'u', participant: 'Bo', anns: [['b1', 'segundo', 2000, 3000]] },
      ],
    });
    const { build } = buildFrom([[xml, 'x.eaf']]);
    expect(build.documents[0].body).toBe('primero\nsegundo\ntercero');
    expect(build.documents[0].alignments.map((a) => a.speaker)).toEqual(['Ana', 'Bo', 'Ana']);
    expect(build.stats.speakers).toEqual(['Ana', 'Bo']);
  });

  it('puts unaligned utterances after the timed ones, in document order', () => {
    const xml = eafXml({
      types: { u: null },
      tiers: [
        {
          id: 'T',
          type: 'u',
          anns: [
            ['a1', 'untimed one', null_ms, null_ms],
            ['a2', 'timed', 1000, 2000],
            ['a3', 'untimed two', null_ms, null_ms],
          ],
        },
      ],
    });
    const { build } = buildFrom([[xml, 'x.eaf']]);
    expect(build.documents[0].body).toBe('timed\nuntimed one\nuntimed two');
    // Only the timed one can carry alignment.
    expect(build.documents[0].alignments).toHaveLength(1);
  });

  it('tokenizes on whitespace when the corpus has no word tier', () => {
    const xml = eafXml({
      types: { u: null, ft: 'Symbolic_Association' },
      tiers: [
        { id: 'T', type: 'u', anns: [['a1', 'sin palabras aqui', 0, 1000]] },
        { id: 'ft', type: 'ft', parent: 'T', anns: [['f1', 'no words here', 'a1', null]] },
      ],
    });
    const { build } = buildFrom([[xml, 'x.eaf']]);
    const doc = build.documents[0];
    expect(doc.words.map((w) => doc.body.slice(w.begin, w.end))).toEqual([
      'sin',
      'palabras',
      'aqui',
    ]);
    expect(doc.words.every((w) => w.morphemes.length === 0)).toBe(true);
    expect(doc.sentences[0].fields).toEqual({ ft: 'no words here' });
  });

  it('renames fields and reports the project schema', () => {
    const parsed = [readEaf(ANA, 'ana.eaf')];
    const { nodes } = compareSchemas(parsed);
    const roles = suggestRoles(nodes);
    const geKey = nodes.find((n) => n.baseName === 'ge').key;
    const ftKey = nodes.find((n) => n.baseName === 'ft').key;
    const build = buildElanDocuments(parsed, nodes, roles, {
      fieldNames: { [geKey]: 'Gloss', [ftKey]: 'Translation' },
    });
    expect(build.schema.fields).toEqual([
      { name: 'Translation', scope: 'Sentence' },
      { name: 'Gloss', scope: 'Morpheme' },
    ]);
    expect(build.documents[0].sentences[0].fields).toEqual({ Translation: 'the dogs run' });
    expect(build.documents[0].words[1].morphemes[0].fields).toEqual({ Gloss: 'dog' });
  });

  it('numbers documents whose names would collide', () => {
    const { build } = buildFrom([
      [ANA, 'Story.eaf'],
      [ANA, 'other/Story.eaf'],
    ]);
    expect(build.documents.map((d) => d.name)).toEqual(['Story (1)', 'Story (2)']);
  });

  it('carries an orthography into token metadata', () => {
    const xml = eafXml({
      types: { u: null, wd: 'Symbolic_Subdivision', ipa: 'Symbolic_Association' },
      tiers: [
        { id: 'T', type: 'u', anns: [['a1', 'casa', 0, 500]] },
        { id: 'wd', type: 'wd', parent: 'T', anns: [['w1', 'casa', 'a1', null]] },
        { id: 'IPA', type: 'ipa', parent: 'wd', anns: [['i1', 'ˈka.sa', 'w1', null]] },
      ],
    });
    const { build, nodes, roles } = buildFrom([[xml, 'x.eaf']]);
    expect(roles[nodes.find((n) => n.baseName === 'IPA').key]).toBe(ROLES.ORTHOGRAPHY);
    expect(build.documents[0].words[0].fields).toEqual({ 'orthog:IPA': 'ˈka.sa' });
    expect(build.schema.orthographies).toEqual(['IPA']);
  });

  it('records the referenced media file and says it is not imported', () => {
    const xml = eafXml({
      types: { u: null },
      tiers: [{ id: 'T', type: 'u', anns: [['a1', 'hola', 0, 500]] }],
      media: 'rec.wav',
    });
    const { build } = buildFrom([[xml, 'x.eaf']]);
    expect(build.documents[0].metadata['Media file']).toBe('rec.wav');
    expect(build.warnings[0]).toMatch(/not imported/);
  });

  it('drops blank utterances rather than emitting a zero-width sentence', () => {
    // A trailing blank annotation is a placeholder real ELAN files carry. Kept,
    // it becomes a zero-width token, which the partitioning sentence layer
    // rejects outright, so the whole document fails to import.
    const xml = eafXml({
      types: { u: null },
      tiers: [
        {
          id: 'T',
          type: 'u',
          anns: [
            ['a1', 'uno', 0, 500],
            ['a2', '', 500, 900],
            ['a3', 'dos', 900, 1500],
            ['a4', '   ', 1500, 1900],
          ],
        },
      ],
    });
    const { build } = buildFrom([[xml, 'x.eaf']]);
    const doc = build.documents[0];
    expect(doc.body).toBe('uno\ndos');
    expect(doc.sentences.map((s) => [s.begin, s.end])).toEqual([
      [0, 4],
      [4, 7],
    ]);
    expect(doc.warnings.some((w) => /2 empty annotations/.test(w))).toBe(true);
  });

  it('counts what the mapping leaves behind, so the loss is not silent', () => {
    // An unmapped tier is dropped in silence otherwise: the import stats only
    // describe what IS imported, so a whole annotation stream can vanish while
    // the summary still reads like a clean run.
    const xml = eafXml({
      types: { u: null, note: 'Symbolic_Association', gest: 'Symbolic_Association' },
      tiers: [
        { id: 'T', type: 'u', anns: [['a1', 'hola mundo', 0, 500]] },
        { id: 'ft', type: 'note', parent: 'T', anns: [['f1', 'hello world', 'a1', null]] },
        {
          id: 'gesture',
          type: 'gest',
          parent: 'T',
          anns: [['g1', 'points left', 'a1', null]],
        },
      ],
    });
    const parsed = [readEaf(xml, 'x.eaf')];
    const { nodes } = compareSchemas(parsed);
    const roles = suggestRoles(nodes);
    const gestureNode = nodes.find((n) => n.baseName === 'gesture');
    // Whatever the suggestion did with it, pin it off: that is the case at issue.
    const build = buildElanDocuments(parsed, nodes, { ...roles, [gestureNode.key]: ROLES.OFF });
    expect(build.stats.skipped).toEqual([{ label: 'gesture', values: 1, tiers: ['gesture'] }]);
  });

  it('reports nothing skipped when every tier carrying values is mapped', () => {
    const { build } = buildFrom([[ANA, 'ana.eaf']]);
    expect(build.stats.skipped).toEqual([]);
  });

  it('keeps HEADER properties as metadata but drops ELAN bookkeeping', () => {
    const xml = eafXml({
      types: { u: null },
      properties: { Researcher: 'Ana', lastUsedAnnotationId: 'a417' },
      tiers: [{ id: 'T', type: 'u', anns: [['a1', 'hola', 0, 500]] }],
    });
    const { build } = buildFrom([[xml, 'x.eaf']]);
    expect(build.documents[0].metadata).toEqual({ Researcher: 'Ana' });
  });

  it('keeps the first value when a field tier has several per parent', () => {
    const xml = eafXml({
      types: { u: null, note: 'Symbolic_Subdivision' },
      tiers: [
        { id: 'T', type: 'u', anns: [['a1', 'hola', 0, 500]] },
        {
          id: 'note',
          type: 'note',
          parent: 'T',
          anns: [
            ['n1', 'first', 'a1', null],
            ['n2', 'second', 'a1', 'n1'],
          ],
        },
      ],
    });
    const noteKey = (() => {
      const parsed = [readEaf(xml, 'x.eaf')];
      return compareSchemas(parsed).nodes.find((n) => n.baseName === 'note').key;
    })();
    const { build } = buildFrom([[xml, 'x.eaf']], { [noteKey]: ROLES.SENTENCE_FIELD });
    expect(build.documents[0].sentences[0].fields).toEqual({ note: 'first' });
    expect(build.documents[0].warnings[0]).toMatch(/kept the first/);
  });
});

describe('several tier trees in one file', () => {
  // A corpus may give each speaker a whole tier tree named by prefix rather than
  // by @participant (the Poio sample does). Taking only the first would silently
  // drop a speaker.
  const twoTrees = () =>
    eafXml({
      types: { u: null, ft: 'Symbolic_Association' },
      tiers: [
        {
          id: 'W-Spch',
          type: 'u',
          anns: [
            ['w1', 'primero', 0, 1000],
            ['w2', 'tercero', 4000, 5000],
          ],
        },
        { id: 'W-ft', type: 'ft', parent: 'W-Spch', anns: [['wf1', 'first', 'w1', null]] },
        { id: 'K-Spch', type: 'u', anns: [['k1', 'segundo', 2000, 3000]] },
        { id: 'K-ft', type: 'ft', parent: 'K-Spch', anns: [['kf1', 'second', 'k1', null]] },
      ],
    });

  it('suggests only ONE utterance tier, never guessing that two are one voice', () => {
    const parsed = [readEaf(twoTrees(), 'x.eaf')];
    const { nodes } = compareSchemas(parsed);
    const roles = suggestRoles(nodes);
    expect(nodes.filter((n) => roles[n.key] === ROLES.UTTERANCE)).toHaveLength(1);
  });

  it('interleaves by time once the user maps the second tree as well', () => {
    const parsed = [readEaf(twoTrees(), 'x.eaf')];
    const { nodes } = compareSchemas(parsed);
    const key = (name) => nodes.find((n) => n.baseName === name).key;
    const roles = {
      ...suggestRoles(nodes),
      [key('K-Spch')]: ROLES.UTTERANCE,
      [key('K-ft')]: ROLES.SENTENCE_FIELD,
    };
    expect(validateRoles(nodes, roles)).toEqual([]);
    const doc = buildElanDocuments(parsed, nodes, roles).documents[0];
    expect(doc.body).toBe('primero\nsegundo\ntercero');
    expect(doc.sentences.map((s) => s.fields['W-ft'] ?? s.fields['K-ft'])).toEqual([
      'first',
      'second',
      undefined,
    ]);
  });

  it('lets two tiers be renamed onto one field, and asks for that layer once', () => {
    const parsed = [readEaf(twoTrees(), 'x.eaf')];
    const { nodes } = compareSchemas(parsed);
    const key = (name) => nodes.find((n) => n.baseName === name).key;
    const roles = {
      ...suggestRoles(nodes),
      [key('K-Spch')]: ROLES.UTTERANCE,
      [key('K-ft')]: ROLES.SENTENCE_FIELD,
    };
    const names = Object.fromEntries(
      nodes.filter((n) => n.baseName.endsWith('-ft')).map((n) => [n.key, 'Translation']),
    );
    const build = buildElanDocuments(parsed, nodes, roles, { fieldNames: names });
    expect(build.schema.fields).toEqual([{ name: 'Translation', scope: 'Sentence' }]);
    expect(build.documents[0].sentences.map((s) => s.fields.Translation)).toEqual([
      'first',
      'second',
      undefined,
    ]);
  });
});

describe('tier names differing only in case', () => {
  // Real file: CoEDL/elan-helpers' Abui fixture has `Phrase` (participant SL)
  // and `phrase`, unrelated tiers holding unrelated text. EAF's TIER_ID is
  // case-sensitive, so this is legal, and they must stay two distinct tiers.
  const abuiShaped = () =>
    eafXml({
      types: { 'default-lt': null, transcription: null, gloss: null },
      tiers: [
        {
          id: 'Phrase',
          type: 'default-lt',
          participant: 'SL',
          anns: [['a1', 'a m a k', 100, 900]],
        },
        { id: 'transcription@speaker1', type: 'transcription', anns: [['a2', 'amak', 200, 700]] },
        { id: 'gloss@speaker1', type: 'gloss', anns: [['a3', 'add gloss here', 300, 800]] },
        { id: 'phrase', type: 'default-lt', anns: [['a4', 'mememe', 0, 1000]] },
      ],
    });

  it('keeps them as separate nodes and never merges them into one role', () => {
    const parsed = [readEaf(abuiShaped(), 'abui.eaf')];
    const { nodes } = compareSchemas(parsed);
    expect(nodes.filter((n) => n.baseName.toLowerCase() === 'phrase')).toHaveLength(2);
    const roles = suggestRoles(nodes);
    const chosen = nodes.filter((n) => roles[n.key] === ROLES.UTTERANCE);
    expect(chosen).toHaveLength(1);
    // Three roots are named plausibly and all hold one annotation, so the tier
    // TYPE is what settles it: `transcription` declares itself, `default-lt`
    // does not.
    expect(chosen[0].baseName).toBe('transcription');
  });

  it('reports the collision so the mapping table is not two rows that read alike', () => {
    const result = compareSchemas([readEaf(abuiShaped(), 'abui.eaf')]);
    expect(result.nearMisses).toEqual([
      { fold: 'phrase', names: ['Phrase', 'phrase'], differsBy: 'capitalization' },
    ]);
  });

  it('names a near-miss difference across the batch for what it is', () => {
    const upper = eafXml({
      types: { u: null },
      tiers: [{ id: 'Phrase', type: 'u', anns: [['a1', 'hola', 0, 100]] }],
    });
    const lower = eafXml({
      types: { u: null },
      tiers: [{ id: 'phrase', type: 'u', anns: [['a1', 'hola', 0, 100]] }],
    });
    const result = compareSchemas([readEaf(upper, 'a.eaf'), readEaf(lower, 'b.eaf')]);
    expect(result.consistent).toBe(false);
    expect(result.differences[0].nearMiss).toEqual(['Phrase']);
  });

  it('has no collisions to report in an ordinary file', () => {
    expect(compareSchemas([readEaf(ANA, 'a.eaf')]).nearMisses).toEqual([]);
  });

  it('merges a near-miss pair onto one agreed name when the user says so', () => {
    const twoTiers = eafXml({
      types: { u: null },
      tiers: [
        { id: 'Phrase', type: 'u', anns: [['a1', 'hola', 0, 100]] },
        { id: 'phrase', type: 'u', anns: [['a2', 'adios', 200, 300]] },
      ],
    });
    const parsed = [readEaf(twoTiers, 'x.eaf')];
    // Untouched they are two tiers, reported as a near miss.
    expect(compareSchemas(parsed).nearMisses).toHaveLength(2 - 1);
    expect(compareSchemas(parsed).nodes).toHaveLength(2);

    // Merged onto "Phrase" they are one node carrying both tiers.
    const canonical = new Map([['phrase', 'Phrase']]);
    const merged = compareSchemas(parsed, canonical);
    expect(merged.nearMisses).toEqual([]);
    expect(merged.nodes).toHaveLength(1);
    expect(merged.nodes[0].baseName).toBe('Phrase');
    expect(merged.nodes[0].tierIds.sort()).toEqual(['Phrase', 'phrase']);

    // And the annotations of both land in the built document.
    const roles = { [merged.nodes[0].key]: ROLES.UTTERANCE };
    const doc = buildElanDocuments(parsed, merged.nodes, roles).documents[0];
    expect(doc.body).toBe('hola\nadios');
  });

  it('a merge makes a batch split by one misspelling consistent again', () => {
    const withName = (id) =>
      eafXml({ types: { u: null }, tiers: [{ id, type: 'u', anns: [['a1', 'hola', 0, 100]] }] });
    const parsed = [readEaf(withName('Phrase'), 'a.eaf'), readEaf(withName('phrase'), 'b.eaf')];
    // The typo splits the batch, and the near miss is found across the groups.
    const split = compareSchemas(parsed);
    expect(split.consistent).toBe(false);
    expect(split.nearMisses).toEqual([
      { fold: 'phrase', names: ['Phrase', 'phrase'], differsBy: 'capitalization' },
    ]);
    // Merging is the way forward that does not mean editing the files in ELAN.
    const merged = compareSchemas(parsed, new Map([['phrase', 'Phrase']]));
    expect(merged.consistent).toBe(true);
    expect(merged.nodes).toHaveLength(1);
  });

  it('catches near misses that are not about case at all', () => {
    const twoTiers = (a, b) =>
      eafXml({
        types: { u: null, s: 'Symbolic_Association' },
        tiers: [
          { id: a, type: 'u', anns: [['a1', 'hola', 0, 100]] },
          { id: b, type: 'u', anns: [['a2', 'adios', 100, 200]] },
        ],
      });
    // A trailing space, which nothing in the table would show.
    expect(compareSchemas([readEaf(twoTiers('ft', 'ft '), 'x.eaf')]).nearMisses).toEqual([
      { fold: 'ft', names: ['ft', 'ft '], differsBy: 'spacing' },
    ]);
    // Composed vs decomposed accents: the same word to a reader, two TIER_IDs.
    const nfc = 'caf\u00e9';
    const nfd = 'cafe\u0301';
    expect(compareSchemas([readEaf(twoTiers(nfc, nfd), 'y.eaf')]).nearMisses).toEqual([
      { fold: 'caf\u00e9', names: [nfc, nfd].sort(), differsBy: 'Unicode spelling' },
    ]);
    // A zero-width space, which is invisible everywhere.
    expect(compareSchemas([readEaf(twoTiers('ref', 'ref\u200b'), 'z.eaf')]).nearMisses).toEqual([
      { fold: 'ref', names: ['ref', 'ref\u200b'].sort(), differsBy: 'invisible characters' },
    ]);
    // And an ordinary pair of distinct names is not a near miss.
    expect(compareSchemas([readEaf(twoTiers('ref', 'gloss'), 'w.eaf')]).nearMisses).toEqual([]);
  });
});

describe('morph forms', () => {
  it('strips the joint and reads a clitic off "="', () => {
    expect(readMorphForm('perro')).toEqual({ form: 'perro', morphType: null });
    // "-" says a boundary is present but not what sits on either side.
    expect(readMorphForm('-s')).toEqual({ form: 's', morphType: null });
    expect(readMorphForm('=lo')).toEqual({ form: 'lo', morphType: 'enclitic' });
  });
});

describe('alignSegments', () => {
  it('places multi-word segments in order', () => {
    const body = 'los perros corren aqui';
    expect(alignSegments(body, 0, body.length, ['los perros', 'corren aqui'])).toEqual([
      { beginU16: 0, endU16: 10 },
      { beginU16: 11, endU16: 22 },
    ]);
  });

  it('returns null for a segment whose text is not there', () => {
    const body = 'los perros';
    expect(alignSegments(body, 0, body.length, ['gatos'])).toEqual([null]);
  });
});

// ---- round trip against our own exporter -----------------------------------

describe('round trip starting from a .eaf', () => {
  // The other direction from the test below: begin at a file, import it, export
  // it, and compare the two FILES. Tier names legitimately change (structural
  // tiers take our own default names), so the comparison is by role.
  const rolesToValues = (xml) => {
    const eaf = readEaf(xml, 'x.eaf');
    const { nodes } = compareSchemas([eaf]);
    const roles = suggestRoles(nodes);
    const roleOfTier = new Map();
    for (const n of nodes)
      for (const id of n.tierIds) roleOfTier.set(id, roles[n.key] ?? ROLES.OFF);
    const out = {};
    for (const tier of eaf.tiers) {
      const role = roleOfTier.get(tier.id) ?? ROLES.OFF;
      const field = [ROLES.SENTENCE_FIELD, ROLES.WORD_FIELD, ROLES.MORPH_FIELD].includes(role);
      const key = field ? `${role}:${tier.baseName}` : role;
      const vals = tier.annotations.map((a) => String(a.value ?? '').trim()).filter(Boolean);
      out[key] = [...(out[key] || []), ...vals];
    }
    return out;
  };

  // The build model in the shape buildEafDocument reads.
  const toIgtDoc = (doc) => ({
    document: { id: 'd1', name: doc.name, mediaUrl: null, metadata: doc.metadata },
    body: doc.body,
    sortedSentences: doc.sentences.map((s, si) => ({
      id: `s${si}`,
      begin: s.begin,
      end: s.end,
      annotations: Object.fromEntries(Object.entries(s.fields).map(([k, v]) => [k, { value: v }])),
      tokens: doc.words
        .filter((w) => w.sentenceIndex === si)
        .map((w, wi) => ({
          id: `w${si}_${wi}`,
          begin: w.begin,
          end: w.end,
          content: doc.body.slice(w.begin, w.end),
          orthographies: {},
          annotations: Object.fromEntries(
            Object.entries(w.fields).map(([k, v]) => [k, { value: v }]),
          ),
          morphemes: w.morphemes.map((m, mi) => ({
            id: `m${si}_${wi}_${mi}`,
            metadata: { form: m.form, morphType: m.morphType },
            annotations: Object.fromEntries(
              Object.entries(m.fields).map(([k, v]) => [k, { value: v }]),
            ),
          })),
        })),
    })),
  });

  it('reproduces every value when the source file agrees with itself', () => {
    const original = ANA;
    const parsed = [readEaf(original, 'ana.eaf')];
    const { nodes } = compareSchemas(parsed);
    const roles = suggestRoles(nodes);
    const build = buildElanDocuments(parsed, nodes, roles);

    const exported = buildEafDocument(
      toIgtDoc(build.documents[0]),
      {
        orthographies: [],
        wordFields: ['ps'],
        morphFields: ['ge'],
        sentFields: ['ft'],
        segmentMorphemes: true,
        // On, which is what makes the morph tier come back spelling its
        // boundaries the way the source file spelled them ("-s", not "s").
        affixMarkers: true,
        perSpeaker: false,
      },
      { exportedAt: '2026-01-01T00:00:00Z', author: 'test' },
    );

    const before = rolesToValues(original);
    const after = rolesToValues(exported);
    expect(after[ROLES.UTTERANCE]).toEqual(before[ROLES.UTTERANCE]);
    expect(after[ROLES.WORD]).toEqual(before[ROLES.WORD]);
    expect(after[ROLES.MORPHEME]).toEqual(before[ROLES.MORPHEME]);
    expect(after[`${ROLES.SENTENCE_FIELD}:ft`]).toEqual(before[`${ROLES.SENTENCE_FIELD}:ft`]);
    expect(after[`${ROLES.MORPH_FIELD}:ge`]).toEqual(before[`${ROLES.MORPH_FIELD}:ge`]);
  });
});

describe('round trip through the .eaf exporter', () => {
  const span = (v) => ({ value: v });
  const sourceDoc = {
    document: { id: 'd1', name: 'Cuento', mediaUrl: null, metadata: { Source: 'notes' } },
    body: 'los perros corren',
    sortedSentences: [
      {
        id: 's1',
        begin: 0,
        end: 17,
        annotations: { Translation: span('The dogs run.') },
        tokens: [
          {
            id: 'w1',
            begin: 0,
            end: 3,
            content: 'los',
            orthographies: { IPA: 'los' },
            annotations: { POS: span('DET') },
            morphemes: [],
          },
          {
            id: 'w2',
            begin: 4,
            end: 10,
            content: 'perros',
            orthographies: {},
            annotations: { POS: span('NOUN') },
            morphemes: [
              {
                id: 'm1',
                metadata: { form: 'perro', morphType: 'stem' },
                annotations: { Gloss: span('dog') },
              },
              {
                id: 'm2',
                metadata: { form: 's', morphType: 'enclitic' },
                annotations: { Gloss: span('PL') },
              },
            ],
          },
          {
            id: 'w3',
            begin: 11,
            end: 17,
            content: 'corren',
            orthographies: {},
            annotations: { POS: span('VERB') },
            morphemes: [],
          },
        ],
      },
    ],
    alignmentTokens: [
      { id: 'a1', begin: 0, end: 17, metadata: { timeBegin: 1.25, timeEnd: 3.5, speaker: 'Ana' } },
    ],
  };

  it('comes back with the same text, tiers, glosses and times', () => {
    const xml = buildEafDocument(
      sourceDoc,
      {
        orthographies: ['IPA'],
        wordFields: ['POS'],
        morphFields: ['Gloss'],
        sentFields: ['Translation'],
        segmentMorphemes: true,
        affixMarkers: true,
        perSpeaker: true,
      },
      { exportedAt: '2026-01-01T00:00:00.000Z' },
    );
    const { build } = buildFrom([[xml, 'Cuento.eaf']]);
    const doc = build.documents[0];

    expect(doc.name).toBe('Cuento');
    expect(doc.metadata.Source).toBe('notes');
    expect(doc.body).toBe('los perros corren');
    expect(doc.sentences[0].fields).toEqual({ Translation: 'The dogs run.' });
    expect(doc.words.map((w) => doc.body.slice(w.begin, w.end))).toEqual([
      'los',
      'perros',
      'corren',
    ]);
    expect(doc.words.map((w) => w.fields.POS)).toEqual(['DET', 'NOUN', 'VERB']);
    expect(doc.words[0].fields['orthog:IPA']).toBe('los');
    expect(doc.words[1].morphemes.map((m) => [m.form, m.fields.Gloss])).toEqual([
      ['perro', 'dog'],
      ['s', 'PL'],
    ]);
    // "=" survives the trip as a clitic; "-" asserts nothing, by design.
    expect(doc.words[1].morphemes[1].morphType).toBe('enclitic');
    expect(doc.alignments).toEqual([
      { begin: 0, end: 17, timeBegin: 1.25, timeEnd: 3.5, speaker: 'Ana' },
    ]);
  });
});
