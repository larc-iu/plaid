// What each export format does with the same project, as a table: whether it
// is a zip at document scope, what it reads (the guidelines, the comments, the
// recording), what the zip holds, and which content type a bare file has. A
// new format, or a change to one format's policy, shows up here as one row.
// Pinned as the export does it today: a single .eaf with a recording becomes a
// zip, and holds no vocabulary TSVs, which are decided before that. Each file
// is pinned by a digest of its bytes, with the clock fixed, so a change to
// what a file says shows up here too (as a changed digest, to be read by
// running the export). Each row also holds the two facts the screens show
// from the format's entry: whether the preset editor offers the vocabularies
// switch, and what the runner says about the zip.
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { runExport } from './runExport.js';
import { discoverExportLayers } from './exportLayers.js';
import { EXPORT_FORMATS, exportFormat, newPreset } from './presets.js';

const role = (r) => ({ plaid: { role: r } });

function rawDoc(id, name, body) {
  const words = [];
  let begin = 0;
  for (const w of body.split(' ')) {
    words.push({ id: `${id}-w${begin}`, begin, end: begin + [...w].length });
    begin += [...w].length + 1;
  }
  return {
    id,
    name,
    mediaUrl: `/api/v1/documents/${id}/media`,
    textLayers: [
      {
        config: role('baseline'),
        text: { body },
        tokenLayers: [
          { config: role('word'), tokens: words, spanLayers: [] },
          {
            config: role('sentence'),
            tokens: [{ id: `${id}-s`, begin: 0, end: [...body].length }],
            spanLayers: [],
          },
        ],
      },
    ],
  };
}

const PROJECT = {
  id: 'p1',
  name: 'Proj',
  textLayers: [
    {
      config: role('baseline'),
      tokenLayers: [
        { config: role('word'), spanLayers: [] },
        { config: role('sentence'), spanLayers: [] },
      ],
    },
  ],
  vocabs: [{ id: 'v1' }],
};

const VOCAB = {
  id: 'v1',
  name: 'Lexicon',
  config: { igt: { fields: { gloss: { inline: true, role: 'gloss' } } } },
  items: [{ id: 'i1', form: 'perro', metadata: { gloss: 'dog' } }],
  vocabLinks: [],
};

const DOCS = [rawDoc('d1', 'Alpha', 'perro yo'), rawDoc('d2', 'Beta', 'ba')];

function client(reads) {
  return {
    guidelines: {
      list: async () => {
        reads.add('guidelines');
        return [];
      },
    },
    comments: {
      list: async () => {
        reads.add('comments');
        return [];
      },
      listInVocab: async () => {
        reads.add('vocabComments');
        return [];
      },
    },
    users: { get: async (id) => ({ id }) },
    projects: { listDocuments: async () => DOCS.map((d) => ({ id: d.id, name: d.name })) },
    documents: {
      get: async (id) => JSON.parse(JSON.stringify(DOCS.find((d) => d.id === id))),
    },
    vocabLayers: {
      get: async (id, includeItems) =>
        includeItems ? JSON.parse(JSON.stringify(VOCAB)) : { id, timeModified: null },
    },
  };
}

// The first 12 hex digits of the SHA-256 of `bytes`.
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

async function run(format, scope, { media = true, vocabularies = true } = {}) {
  const reads = new Set();
  const made = newPreset(format, discoverExportLayers(PROJECT), 'p');
  const preset = {
    ...made,
    includeVocabularies: vocabularies,
    ...(media ? {} : { options: { ...made.options, includeMedia: false } }),
  };
  const result = await runExport({
    client: client(reads),
    project: PROJECT,
    preset,
    scope,
    fetchMedia: async () => {
      reads.add('media');
      return { bytes: new Uint8Array([1]), ext: '.wav', mime: 'audio/wav' };
    },
  });
  const zipped = result.filename.endsWith('.zip');
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  const entries = zipped ? unzipSync(bytes) : null;
  return {
    filename: result.filename,
    type: zipped ? null : result.blob.type,
    // Each file of a zip by name, with its digest, and a bare file's digest.
    files: zipped
      ? Object.fromEntries(
          Object.keys(entries)
            .sort()
            .map((name) => [name, digest(entries[name])]),
        )
      : digest(bytes),
    reads: [...reads].sort(),
  };
}

const ROWS = {
  plaintext: {
    screens: {
      vocabularyTsvs: true,
      zipNote: null,
    },
    document: {
      filename: 'Alpha.txt',
      type: 'text/plain;charset=utf-8',
      files: '8966ccdbb959',
      reads: [],
    },
    noMedia: {
      filename: 'Alpha.txt',
      type: 'text/plain;charset=utf-8',
      files: '8966ccdbb959',
      reads: [],
    },
    project: {
      filename: 'Proj-export.zip',
      type: null,
      files: {
        'documents/Alpha.txt': '8966ccdbb959',
        'documents/Beta.txt': 'ddbd3e946871',
        'vocabularies/Lexicon.tsv': '2e3edee2facd',
      },
      reads: [],
    },
    noVocabularies: {
      filename: 'Proj-export.zip',
      type: null,
      files: {
        'documents/Alpha.txt': '8966ccdbb959',
        'documents/Beta.txt': 'ddbd3e946871',
      },
      reads: [],
    },
  },
  flextext: {
    screens: {
      vocabularyTsvs: false,
      zipNote:
        'This format produces one .flextext for the whole run. With the lexicon included (set in the preset) it becomes a .zip pairing that file with the lexicon as LIFT.',
    },
    document: {
      filename: 'Alpha-flex.zip',
      type: null,
      files: {
        'Alpha.flextext': 'b64668f5ec32',
        'Alpha.lift': '24ff3180fa70',
        'README.txt': '1e5c129cb291',
      },
      reads: [],
    },
    noMedia: {
      filename: 'Alpha-flex.zip',
      type: null,
      files: {
        'Alpha.flextext': 'b64668f5ec32',
        'Alpha.lift': '24ff3180fa70',
        'README.txt': '1e5c129cb291',
      },
      reads: [],
    },
    project: {
      filename: 'Proj-flex.zip',
      type: null,
      files: {
        'Proj.flextext': '1a48a83e0cbf',
        'Proj.lift': '24ff3180fa70',
        'README.txt': '82f1db157e58',
      },
      reads: [],
    },
    noVocabularies: {
      filename: 'Proj-flex.zip',
      type: null,
      files: {
        'Proj.flextext': '1a48a83e0cbf',
        'Proj.lift': '24ff3180fa70',
        'README.txt': '82f1db157e58',
      },
      reads: [],
    },
  },
  cldf: {
    screens: {
      vocabularyTsvs: false,
      zipNote:
        'This format always produces a .zip dataset (one CSV per CLDF component table) whatever the scope. Whether the lexicon is included is set in the preset.',
    },
    document: {
      filename: 'Alpha-cldf.zip',
      type: null,
      files: {
        'cldf-metadata.json': 'e818591436e8',
        'contributions.csv': 'd3a11f258074',
        'entries.csv': 'c2f2ed91d419',
        'examples.csv': '5bff93085943',
        'languages.csv': '5b42ca8a2c45',
        'media.csv': '2314bf7c9b3f',
        'media/Alpha.wav': '4bf5122f3445',
        'senses.csv': '772c43f34186',
      },
      reads: ['media'],
    },
    noMedia: {
      filename: 'Alpha-cldf.zip',
      type: null,
      files: {
        'cldf-metadata.json': '90f22364266f',
        'contributions.csv': 'd3a11f258074',
        'entries.csv': 'c2f2ed91d419',
        'examples.csv': '5bff93085943',
        'languages.csv': '5b42ca8a2c45',
        'senses.csv': '772c43f34186',
      },
      reads: [],
    },
    project: {
      filename: 'Proj-cldf.zip',
      type: null,
      files: {
        'cldf-metadata.json': 'e818591436e8',
        'contributions.csv': '91edb41f0409',
        'entries.csv': 'c2f2ed91d419',
        'examples.csv': '893d3a26d97d',
        'languages.csv': '5b42ca8a2c45',
        'media.csv': '2e3be25600bb',
        'media/Alpha.wav': '4bf5122f3445',
        'media/Beta.wav': '4bf5122f3445',
        'senses.csv': '772c43f34186',
      },
      reads: ['media'],
    },
    noVocabularies: {
      filename: 'Proj-cldf.zip',
      type: null,
      files: {
        'cldf-metadata.json': 'e818591436e8',
        'contributions.csv': '91edb41f0409',
        'entries.csv': 'c2f2ed91d419',
        'examples.csv': '893d3a26d97d',
        'languages.csv': '5b42ca8a2c45',
        'media.csv': '2e3be25600bb',
        'media/Alpha.wav': '4bf5122f3445',
        'media/Beta.wav': '4bf5122f3445',
        'senses.csv': '772c43f34186',
      },
      reads: ['media'],
    },
  },
  elan: {
    screens: {
      vocabularyTsvs: true,
      zipNote: null,
    },
    document: {
      filename: 'Alpha-export.zip',
      type: null,
      files: {
        'documents/Alpha.eaf': 'ed3bfb6c05d1',
        'media/Alpha.wav': '4bf5122f3445',
      },
      reads: ['media'],
    },
    noMedia: {
      filename: 'Alpha.eaf',
      type: 'text/xml;charset=utf-8',
      files: 'be39a84a7a9e',
      reads: [],
    },
    project: {
      filename: 'Proj-export.zip',
      type: null,
      files: {
        'documents/Alpha.eaf': 'ed3bfb6c05d1',
        'documents/Beta.eaf': 'd8fc46bf3262',
        'media/Alpha.wav': '4bf5122f3445',
        'media/Beta.wav': '4bf5122f3445',
        'vocabularies/Lexicon.tsv': '2e3edee2facd',
      },
      reads: ['media'],
    },
    noVocabularies: {
      filename: 'Proj-export.zip',
      type: null,
      files: {
        'documents/Alpha.eaf': 'ed3bfb6c05d1',
        'documents/Beta.eaf': 'd8fc46bf3262',
        'media/Alpha.wav': '4bf5122f3445',
        'media/Beta.wav': '4bf5122f3445',
      },
      reads: ['media'],
    },
  },
  latex: {
    screens: {
      vocabularyTsvs: false,
      zipNote:
        'This format always produces a .zip of LaTeX source, one chapter per document, whatever the scope.',
    },
    document: {
      filename: 'Alpha-latex.zip',
      type: null,
      files: {
        'README.txt': '507e10aa63c3',
        'abbreviations.tex': '7b7501e5165c',
        latexmkrc: 'd2b086824cab',
        'main.tex': '5b5a3ac46b8b',
        'texts/001-alpha.tex': '6e2728dffac3',
      },
      reads: [],
    },
    noMedia: {
      filename: 'Alpha-latex.zip',
      type: null,
      files: {
        'README.txt': '507e10aa63c3',
        'abbreviations.tex': '7b7501e5165c',
        latexmkrc: 'd2b086824cab',
        'main.tex': '5b5a3ac46b8b',
        'texts/001-alpha.tex': '6e2728dffac3',
      },
      reads: [],
    },
    project: {
      filename: 'Proj-latex.zip',
      type: null,
      files: {
        'README.txt': 'aa4bc9e57f13',
        'abbreviations.tex': '7b7501e5165c',
        latexmkrc: 'd2b086824cab',
        'main.tex': 'ec1754ed73c0',
        'texts/001-alpha.tex': '6e2728dffac3',
        'texts/002-beta.tex': 'feddfb935237',
      },
      reads: [],
    },
    noVocabularies: {
      filename: 'Proj-latex.zip',
      type: null,
      files: {
        'README.txt': 'aa4bc9e57f13',
        'abbreviations.tex': '7b7501e5165c',
        latexmkrc: 'd2b086824cab',
        'main.tex': 'ec1754ed73c0',
        'texts/001-alpha.tex': '6e2728dffac3',
        'texts/002-beta.tex': 'feddfb935237',
      },
      reads: [],
    },
  },
  'plaid-igt-json': {
    screens: {
      vocabularyTsvs: false,
      zipNote:
        'This format always produces a .zip archive including all vocabularies and the project configuration, whatever the scope.',
    },
    document: {
      filename: 'Alpha-export.zip',
      type: null,
      files: {
        'documents/Alpha.json': 'b94c3ff6546f',
        'media/Alpha.wav': '4bf5122f3445',
        'project.json': '49f6ef7d46c2',
        'vocabularies/Lexicon.json': '3bc4c6dfaaf8',
      },
      reads: ['comments', 'guidelines', 'media', 'vocabComments'],
    },
    noMedia: {
      filename: 'Alpha-export.zip',
      type: null,
      files: {
        'documents/Alpha.json': 'c8032dd9843c',
        'project.json': '81299fea6b80',
        'vocabularies/Lexicon.json': '3bc4c6dfaaf8',
      },
      reads: ['comments', 'guidelines', 'vocabComments'],
    },
    project: {
      filename: 'Proj-export.zip',
      type: null,
      files: {
        'documents/Alpha.json': 'b94c3ff6546f',
        'documents/Beta.json': '6d4432238c17',
        'media/Alpha.wav': '4bf5122f3445',
        'media/Beta.wav': '4bf5122f3445',
        'project.json': 'dc69cbabfbe5',
        'vocabularies/Lexicon.json': '3bc4c6dfaaf8',
      },
      reads: ['comments', 'guidelines', 'media', 'vocabComments'],
    },
    noVocabularies: {
      filename: 'Proj-export.zip',
      type: null,
      files: {
        'documents/Alpha.json': 'b94c3ff6546f',
        'documents/Beta.json': '6d4432238c17',
        'media/Alpha.wav': '4bf5122f3445',
        'media/Beta.wav': '4bf5122f3445',
        'project.json': 'dc69cbabfbe5',
        'vocabularies/Lexicon.json': '3bc4c6dfaaf8',
      },
      reads: ['comments', 'guidelines', 'media', 'vocabComments'],
    },
  },
};

describe('what each export format makes of one project', () => {
  // A clock fixed for every case, since some files carry the export's date.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
  });
  afterAll(() => vi.useRealTimers());

  it('has a row for every format', () => {
    expect(Object.keys(ROWS).sort()).toEqual(EXPORT_FORMATS.map((f) => f.id).sort());
  });

  const check = (id, kind, actual) => expect(actual).toEqual(ROWS[id][kind]);

  for (const { id } of EXPORT_FORMATS) {
    it(`${id}: what the screens say`, () => {
      const { vocabularyTsvs, zipNote } = exportFormat(id);
      check(id, 'screens', { vocabularyTsvs, zipNote });
    });
    it(`${id} at document scope`, async () => {
      check(id, 'document', await run(id, { type: 'document', id: 'd1' }));
    });
    it(`${id} at document scope with no recording`, async () => {
      check(id, 'noMedia', await run(id, { type: 'document', id: 'd1' }, { media: false }));
    });
    it(`${id} at project scope`, async () => {
      check(id, 'project', await run(id, { type: 'project' }));
    });
    it(`${id} at project scope with the vocabularies off`, async () => {
      check(id, 'noVocabularies', await run(id, { type: 'project' }, { vocabularies: false }));
    });
  }
});
