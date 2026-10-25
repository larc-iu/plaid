// What each export format does with the same project, as a table: whether it
// is a zip at document scope, what it reads (the guidelines, the comments, the
// recording), what the zip holds, and which content type a bare file has. A
// new format, or a change to one format's policy, shows up here as one row.
// Pinned as the export does it today: a single .eaf with a recording becomes a
// zip, and holds no vocabulary TSVs, which are decided before that.
import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { runExport } from './runExport.js';
import { discoverExportLayers } from './exportLayers.js';
import { EXPORT_FORMATS, newPreset } from './presets.js';

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

async function run(format, scope, { media = true } = {}) {
  const reads = new Set();
  const made = newPreset(format, discoverExportLayers(PROJECT), 'p');
  const preset = {
    ...made,
    includeVocabularies: true,
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
  return {
    filename: result.filename,
    type: zipped ? null : result.blob.type,
    files: zipped
      ? Object.keys(unzipSync(new Uint8Array(await result.blob.arrayBuffer()))).sort()
      : null,
    reads: [...reads].sort(),
  };
}

const ROWS = {
  plaintext: {
    document: {
      filename: 'Alpha.txt',
      type: 'text/plain;charset=utf-8',
      files: null,
      reads: [],
    },
    noMedia: {
      filename: 'Alpha.txt',
      type: 'text/plain;charset=utf-8',
      files: null,
      reads: [],
    },
    project: {
      filename: 'Proj-export.zip',
      type: null,
      files: ['documents/Alpha.txt', 'documents/Beta.txt', 'vocabularies/Lexicon.tsv'],
      reads: [],
    },
  },
  flextext: {
    document: {
      filename: 'Alpha-flex.zip',
      type: null,
      files: ['Alpha.flextext', 'Alpha.lift', 'README.txt'],
      reads: [],
    },
    noMedia: {
      filename: 'Alpha-flex.zip',
      type: null,
      files: ['Alpha.flextext', 'Alpha.lift', 'README.txt'],
      reads: [],
    },
    project: {
      filename: 'Proj-flex.zip',
      type: null,
      files: ['Proj.flextext', 'Proj.lift', 'README.txt'],
      reads: [],
    },
  },
  cldf: {
    document: {
      filename: 'Alpha-cldf.zip',
      type: null,
      files: [
        'cldf-metadata.json',
        'contributions.csv',
        'entries.csv',
        'examples.csv',
        'languages.csv',
        'media.csv',
        'media/Alpha.wav',
        'senses.csv',
      ],
      reads: ['media'],
    },
    noMedia: {
      filename: 'Alpha-cldf.zip',
      type: null,
      files: [
        'cldf-metadata.json',
        'contributions.csv',
        'entries.csv',
        'examples.csv',
        'languages.csv',
        'senses.csv',
      ],
      reads: [],
    },
    project: {
      filename: 'Proj-cldf.zip',
      type: null,
      files: [
        'cldf-metadata.json',
        'contributions.csv',
        'entries.csv',
        'examples.csv',
        'languages.csv',
        'media.csv',
        'media/Alpha.wav',
        'media/Beta.wav',
        'senses.csv',
      ],
      reads: ['media'],
    },
  },
  elan: {
    document: {
      filename: 'Alpha-export.zip',
      type: null,
      files: ['documents/Alpha.eaf', 'media/Alpha.wav'],
      reads: ['media'],
    },
    noMedia: {
      filename: 'Alpha.eaf',
      type: 'text/xml;charset=utf-8',
      files: null,
      reads: [],
    },
    project: {
      filename: 'Proj-export.zip',
      type: null,
      files: [
        'documents/Alpha.eaf',
        'documents/Beta.eaf',
        'media/Alpha.wav',
        'media/Beta.wav',
        'vocabularies/Lexicon.tsv',
      ],
      reads: ['media'],
    },
  },
  latex: {
    document: {
      filename: 'Alpha-latex.zip',
      type: null,
      files: ['README.txt', 'abbreviations.tex', 'latexmkrc', 'main.tex', 'texts/001-alpha.tex'],
      reads: [],
    },
    noMedia: {
      filename: 'Alpha-latex.zip',
      type: null,
      files: ['README.txt', 'abbreviations.tex', 'latexmkrc', 'main.tex', 'texts/001-alpha.tex'],
      reads: [],
    },
    project: {
      filename: 'Proj-latex.zip',
      type: null,
      files: [
        'README.txt',
        'abbreviations.tex',
        'latexmkrc',
        'main.tex',
        'texts/001-alpha.tex',
        'texts/002-beta.tex',
      ],
      reads: [],
    },
  },
  'plaid-igt-json': {
    document: {
      filename: 'Alpha-export.zip',
      type: null,
      files: [
        'documents/Alpha.json',
        'media/Alpha.wav',
        'project.json',
        'vocabularies/Lexicon.json',
      ],
      reads: ['comments', 'guidelines', 'media', 'vocabComments'],
    },
    noMedia: {
      filename: 'Alpha-export.zip',
      type: null,
      files: ['documents/Alpha.json', 'project.json', 'vocabularies/Lexicon.json'],
      reads: ['comments', 'guidelines', 'vocabComments'],
    },
    project: {
      filename: 'Proj-export.zip',
      type: null,
      files: [
        'documents/Alpha.json',
        'documents/Beta.json',
        'media/Alpha.wav',
        'media/Beta.wav',
        'project.json',
        'vocabularies/Lexicon.json',
      ],
      reads: ['comments', 'guidelines', 'media', 'vocabComments'],
    },
  },
};

describe('what each export format makes of one project', () => {
  it('has a row for every format', () => {
    expect(Object.keys(ROWS).sort()).toEqual(EXPORT_FORMATS.map((f) => f.id).sort());
  });

  for (const { id } of EXPORT_FORMATS) {
    it(`${id} at document scope`, async () => {
      expect(await run(id, { type: 'document', id: 'd1' })).toEqual(ROWS[id].document);
    });
    it(`${id} at document scope with no recording`, async () => {
      expect(await run(id, { type: 'document', id: 'd1' }, { media: false })).toEqual(
        ROWS[id].noMedia,
      );
    });
    it(`${id} at project scope`, async () => {
      expect(await run(id, { type: 'project' })).toEqual(ROWS[id].project);
    });
  }
});
