// igt reads a punctuation token exactly as untokenized punctuation (Luke,
// 2026-10-16: "I don't want Analyze to behave differently because you started
// doing UD annotation"). ud's Tokenize makes a token for each run of
// punctuation no token covers, in the token layer igt shares. The oracle: the
// same documents with and without those tokens, diffed view by view and
// export by export. Only the native archive, a lossless backup, may differ,
// and only by holding the tokens.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { unzipSync } from 'fflate';
import { runExport } from '../export/runExport.js';
import { discoverExportLayers } from '../export/exportLayers.js';
import { EXPORT_FORMATS, newPreset } from '../export/presets.js';
import { IgtDocument } from './IgtDocument.js';
import { bareIgnoredSentence } from './derive.js';
import { COPY_FORMATS, formatSentence } from './igtExport.js';
import { readIgnoredTokens } from './igtConfig.js';
import { tokenizeText, findUntokenizedRanges } from '../utils/tokenizationUtils.js';

const role = (r) => ({ plaid: { role: r } });
const PUNCT = { igt: { ignoredTokens: { type: 'unicodePunctuation', whitelist: ["'"] } } };

const PROJECT = {
  id: 'p1',
  name: 'P',
  textLayers: [
    {
      id: 'tl',
      config: role('baseline'),
      tokenLayers: [
        {
          id: 'wordL',
          config: { ...role('word'), ...PUNCT },
          spanLayers: [{ id: 'glossL', name: 'Gloss', config: { igt: { scope: 'Word' } } }],
        },
        {
          id: 'morphL',
          config: role('morpheme'),
          spanLayers: [{ id: 'mglossL', name: 'Gloss', config: { igt: { scope: 'Morpheme' } } }],
        },
        {
          id: 'sentL',
          config: role('sentence'),
          spanLayers: [
            { id: 'transL', name: 'Translation', config: { igt: { scope: 'Sentence' } } },
          ],
        },
      ],
    },
  ],
  vocabs: [],
};

// Sentences as typed, punctuation of every shape: final, inner, a run, an
// opening mark glued to a word, quotes, a letter-like apostrophe, a lone
// symbol, and a sentence of punctuation only.
const SENTENCES = [
  'Ana runs.',
  '¿Qué pasa?!',
  '"Ben," she said... then left!',
  "k'a ta, (ma) — no.",
  '« Ça va » ; oui ?',
  '...',
  'x + y = z',
];

// A document as igt makes it: the words its own tokenizer cuts, a stored
// morpheme on every other word, a gloss on each word and morpheme and a
// translation on each sentence. With `punct`, also a token over each run of
// punctuation no word covers, as ud's Tokenize makes them.
function buildRaw({ punct }) {
  const body = SENTENCES.join(' ');
  const cfg = readIgnoredTokens(PROJECT.textLayers[0].tokenLayers[0].config);
  const cps = [...body];
  const sentences = [];
  let at = 0;
  SENTENCES.forEach((s, i) => {
    const len = [...s].length;
    sentences.push({ id: `s${i}`, text: 't1', begin: at, end: at + len });
    at += len + 1;
  });
  const words = tokenizeText(body, cfg, findUntokenizedRanges(body, [])).map((t, i) => ({
    id: `w${i}`,
    text: 't1',
    begin: t.begin,
    end: t.end,
    metadata: {},
  }));
  const tokens = [...words];
  if (punct) {
    const covered = new Array(cps.length).fill(false);
    for (const w of words) for (let k = w.begin; k < w.end; k++) covered[k] = true;
    let k = 0;
    let n = 0;
    while (k < cps.length) {
      if (covered[k] || /\s/u.test(cps[k])) {
        k++;
        continue;
      }
      const begin = k;
      while (k < cps.length && !covered[k] && !/\s/u.test(cps[k])) k++;
      tokens.push({ id: `p${n++}`, text: 't1', begin, end: k, metadata: {} });
    }
    tokens.sort((a, b) => a.begin - b.begin);
  }
  const morphs = words
    .filter((_, i) => i % 2 === 0)
    .map((w) => ({ ...w, id: `m-${w.id}`, precedence: 1 }));
  return {
    id: 'd1',
    name: 'Doc',
    textLayers: [
      {
        id: 'tl',
        config: role('baseline'),
        text: { id: 't1', body },
        tokenLayers: [
          {
            ...PROJECT.textLayers[0].tokenLayers[0],
            tokens,
            spanLayers: [
              {
                ...PROJECT.textLayers[0].tokenLayers[0].spanLayers[0],
                spans: words.map((w) => ({ id: `g-${w.id}`, tokens: [w.id], value: `G${w.id}` })),
              },
            ],
          },
          {
            ...PROJECT.textLayers[0].tokenLayers[1],
            tokens: morphs,
            spanLayers: [
              {
                ...PROJECT.textLayers[0].tokenLayers[1].spanLayers[0],
                spans: morphs.map((m) => ({ id: `g-${m.id}`, tokens: [m.id], value: `M${m.id}` })),
              },
            ],
          },
          {
            ...PROJECT.textLayers[0].tokenLayers[2],
            tokens: sentences,
            spanLayers: [
              {
                ...PROJECT.textLayers[0].tokenLayers[2].spanLayers[0],
                spans: sentences.map((s) => ({
                  id: `t-${s.id}`,
                  tokens: [s.id],
                  value: `T ${s.id}`,
                })),
              },
            ],
          },
        ],
      },
    ],
  };
}

const PLAIN = buildRaw({ punct: false });
const WITH_PUNCT = buildRaw({ punct: true });

const clientFor = (raw) => ({
  projects: { listDocuments: async () => [{ id: 'd1', name: 'Doc' }] },
  documents: { get: async () => structuredClone(raw) },
  vocabLayers: { get: async (id) => ({ id, items: [] }) },
  comments: { list: async () => [], listInVocab: async () => [] },
  guidelines: { list: async () => [] },
});

const allText = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const files = zipped
    ? Object.entries(unzipSync(bytes)).sort(([a], [b]) => a.localeCompare(b))
    : [['', bytes]];
  return files.map(([name, b]) => `== ${name}\n${new TextDecoder().decode(b)}`).join('\n');
};

const exportAs = async (raw, format) => {
  const preset = newPreset(format, discoverExportLayers(PROJECT), format);
  const result = await runExport({
    client: clientFor(raw),
    project: PROJECT,
    preset,
    scope: { type: 'document', id: 'd1' },
    fetchMedia: async () => {
      throw new Error('no media');
    },
  });
  return allText(result.blob);
};

const open = (raw) => new IgtDocument({ raw: structuredClone(raw), project: PROJECT });

// The Analyze view of a sentence: its words and the text between them, with
// every value drawn. Ids are left out (a token's id is not shown).
const view = (doc) =>
  doc.sentences.map((s) => ({
    begin: s.begin,
    end: s.end,
    translation: s.annotations.Translation?.value ?? null,
    pieces: s.pieces.map((p) =>
      p.type === 'gap'
        ? { gap: p.content, begin: p.begin, end: p.end }
        : {
            word: p.content,
            begin: p.begin,
            end: p.end,
            gloss: p.annotations?.Gloss?.value ?? null,
            morphemes: (p.morphemes || []).map((m) => [m.content, m.annotations?.Gloss?.value]),
          },
    ),
  }));

describe('a punctuation token ud made reads as untokenized punctuation', () => {
  // The CLDF and ELAN files carry the time they were written.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
  });
  afterAll(() => vi.useRealTimers());

  it('the fixture holds punctuation tokens', () => {
    const extra =
      WITH_PUNCT.textLayers[0].tokenLayers[0].tokens.length -
      PLAIN.textLayers[0].tokenLayers[0].tokens.length;
    expect(extra).toBeGreaterThan(10);
  });

  it('Analyze draws the same sentences, words, text between and values', () => {
    expect(view(open(WITH_PUNCT))).toEqual(view(open(PLAIN)));
  });

  for (const { id } of EXPORT_FORMATS.filter((f) => f.id !== 'plaid-igt-json')) {
    it(`the ${id} export is the same`, async () => {
      expect(await exportAs(WITH_PUNCT, id)).toEqual(await exportAs(PLAIN, id));
    });
  }

  for (const { id } of COPY_FORMATS) {
    it(`the ${id} copy is the same`, () => {
      const fields = { morphFields: ['Gloss'], wordFields: ['Gloss'], sentFields: ['Translation'] };
      const copies = (raw) => {
        const doc = open(raw);
        const cfg = readIgnoredTokens(doc.layerInfo.primaryTokenLayer.config);
        return doc.sentences.map((s) => formatSentence(bareIgnoredSentence(s, cfg), fields, id));
      };
      expect(copies(WITH_PUNCT)).toEqual(copies(PLAIN));
    });
  }
});
